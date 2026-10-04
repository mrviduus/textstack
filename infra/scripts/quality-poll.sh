#!/bin/bash
# Polls DB for book quality validation jobs and processes them via Claude CLI.
# Two-phase: 1) Validate (detect issues) 2) Fix (apply corrections via internal API).
# Requires: claude CLI (Max subscription), docker (for psql via db container), curl.
# Usage: ./infra/scripts/quality-poll.sh
# Run via: systemd, tmux, or screen.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
POLL_INTERVAL=30
API_BASE="http://localhost:8080"

# Phase 3 (per-chapter content cleanup). Off unless CONTENT_CLEANUP_ENABLED=true
# in .env. Chapters scoring below the threshold (ChapterContentQualityAnalyzer)
# get an LLM cleanup pass; output is verified by pdf-cleanup-gate.py.
CONTENT_CLEANUP_ENABLED="${CONTENT_CLEANUP_ENABLED:-false}"
CONTENT_QUALITY_THRESHOLD="${CONTENT_QUALITY_THRESHOLD:-60}"
# Per-chapter Claude timeout. 16k-word chapters take ~10 min; 20k+ chapters
# (the longest tech books have) need ~15-20 min — 900s was tight, dropped one
# in prod testing. Env-tunable for the rare outliers; 1500s default covers
# the realistic upper bound.
CLEANUP_TIMEOUT="${CLEANUP_TIMEOUT:-1500}"
DATASET_DIR="$REPO_DIR/data/pdf-cleanup-dataset"
GATE_SCRIPT="$REPO_DIR/infra/scripts/pdf-cleanup-gate.py"

# Status codes (match BookQualityJobStatus enum)
STATUS_QUEUED=0
STATUS_VALIDATING=1
STATUS_FIXING=2
STATUS_COMPLETED=3
STATUS_FAILED=4

# Load .env
if [ -f "$REPO_DIR/.env" ]; then
  set -a
  source "$REPO_DIR/.env"
  set +a
fi

for var in POSTGRES_USER POSTGRES_DB; do
  if [ -z "${!var:-}" ]; then
    echo "ERROR: $var not set. Check .env file." >&2
    exit 1
  fi
done

# Add claude CLI to PATH
for claude_dir in "$HOME"/.vscode/extensions/anthropic.claude-code-*/resources/native-binary; do
  [ -d "$claude_dir" ] && export PATH="$claude_dir:$PATH" && break
done

log() { echo "[$(date '+%H:%M:%S')] $*"; }
# shellcheck source=infra/scripts/claude-isolated.sh
source "$REPO_DIR/infra/scripts/claude-isolated.sh"

db_query() {
  docker compose -f "$REPO_DIR/docker-compose.yml" exec -T db \
    psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "$1" 2>/dev/null
}

db_exec() {
  docker compose -f "$REPO_DIR/docker-compose.yml" exec -T db \
    psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "$1" 2>/dev/null
}

escape_sql() {
  echo "$1" | sed "s/'/''/g"
}

update_job() {
  local job_id="$1"
  shift
  local esc_fields="$*"
  curl -s -X PUT "$API_BASE/internal/quality-jobs/$job_id" \
    -H "Content-Type: application/json" \
    -d "$esc_fields" >/dev/null 2>&1 || \
  db_exec "UPDATE book_quality_jobs SET $esc_fields WHERE id = '$job_id';" >/dev/null 2>&1
}

update_job_api() {
  local job_id="$1"
  shift
  curl -s -X PUT "$API_BASE/internal/quality-jobs/$job_id" \
    -H "Content-Type: application/json" \
    -d "$1" >/dev/null 2>&1
}

# Fetch chapter list for an edition or user book
fetch_chapters() {
  local type="$1" id="$2"
  if [ "$type" = "edition" ]; then
    curl -s "$API_BASE/internal/editions/$id/chapters"
  else
    curl -s "$API_BASE/internal/user-books/$id/chapters"
  fi
}

# Fetch chapter content sample (first N chars of plainText)
fetch_chapter_sample() {
  local type="$1" id="$2" chapter_num="$3"
  if [ "$type" = "edition" ]; then
    curl -s "$API_BASE/internal/editions/$id/chapters/$chapter_num/content"
  else
    curl -s "$API_BASE/internal/user-books/$id/chapters/$chapter_num/content"
  fi
}

# Apply fix via internal API
apply_delete() {
  local type="$1" id="$2" chapter_num="$3"
  if [ "$type" = "edition" ]; then
    curl -s -X DELETE "$API_BASE/internal/editions/$id/chapters/$chapter_num"
  else
    curl -s -X DELETE "$API_BASE/internal/user-books/$id/chapters/$chapter_num"
  fi
}

apply_rename() {
  local type="$1" id="$2" chapter_num="$3" new_title="$4"
  local esc_title
  esc_title=$(echo "$new_title" | python3 -c "import sys,json; print(json.dumps(sys.stdin.read().strip()))" 2>/dev/null || echo "\"$new_title\"")
  if [ "$type" = "edition" ]; then
    curl -s -X PUT "$API_BASE/internal/editions/$id/chapters/$chapter_num" \
      -H "Content-Type: application/json" \
      -d "{\"title\":$esc_title}"
  else
    curl -s -X PUT "$API_BASE/internal/user-books/$id/chapters/$chapter_num" \
      -H "Content-Type: application/json" \
      -d "{\"title\":$esc_title}"
  fi
}

apply_merge() {
  local type="$1" id="$2" numbers_json="$3"
  if [ "$type" = "edition" ]; then
    curl -s -X POST "$API_BASE/internal/editions/$id/chapters/merge" \
      -H "Content-Type: application/json" \
      -d "{\"chapterNumbers\":$numbers_json}"
  else
    curl -s -X POST "$API_BASE/internal/user-books/$id/chapters/merge" \
      -H "Content-Type: application/json" \
      -d "{\"chapterNumbers\":$numbers_json}"
  fi
}

# Overwrite a chapter's HTML (PUT recomputes plainText server-side).
# $4 is a JSON-encoded string (quotes included).
apply_content() {
  local type="$1" id="$2" chapter_num="$3" esc_html="$4"
  if [ "$type" = "edition" ]; then
    curl -s -X PUT "$API_BASE/internal/editions/$id/chapters/$chapter_num" \
      -H "Content-Type: application/json" -d "{\"html\":$esc_html}" >/dev/null
  else
    curl -s -X PUT "$API_BASE/internal/user-books/$id/chapters/$chapter_num" \
      -H "Content-Type: application/json" -d "{\"html\":$esc_html}" >/dev/null
  fi
}

# Phase 3 — per-chapter content cleanup. For each chapter scoring below the
# quality threshold, ask Claude to fix structure only, verify the output with
# the preservation gate, then overwrite the chapter HTML. Every (messy→clean)
# pair is logged to the dataset dir for the heuristic ratchet (feat-0007).
run_content_cleanup() {
  local job_id="$1" target_type="$2" target_id="$3" book_title="$4"

  if [ "$CONTENT_CLEANUP_ENABLED" != "true" ]; then
    return 0
  fi

  local chapter_table id_col
  if [ "$target_type" = "edition" ]; then
    chapter_table="chapters"; id_col="edition_id"
  else
    chapter_table="user_chapters"; id_col="user_book_id"
  fi

  local flagged
  flagged=$(db_query "SELECT chapter_number FROM $chapter_table \
    WHERE $id_col='$target_id' AND content_quality_score IS NOT NULL \
    AND content_quality_score < $CONTENT_QUALITY_THRESHOLD ORDER BY chapter_number")

  if [ -z "$flagged" ]; then
    log "Phase 3: no chapters below quality threshold ($CONTENT_QUALITY_THRESHOLD)"
    return 0
  fi

  # Dataset dir lives under data/ (root-owned) — created + chowned to the
  # poller's uid by `make fix-permissions`. Degrade gracefully if missing:
  # cleanup still runs, only the (messy→clean) pair log is skipped.
  if ! mkdir -p "$DATASET_DIR" 2>/dev/null; then
    log "Phase 3: warning — $DATASET_DIR not writable, pairs will not be logged"
    DATASET_DIR=""
  fi
  local cleaned=0 rejected=0 skipped=0

  for num in $flagged; do
    local content_json html
    content_json=$(fetch_chapter_sample "$target_type" "$target_id" "$num")
    html=$(echo "$content_json" | python3 -c \
      "import sys,json; print(json.load(sys.stdin).get('html','') or '')" 2>/dev/null)

    if [ -z "$html" ]; then
      log "Phase 3: chapter $num — no HTML, skipped"
      skipped=$((skipped + 1)); continue
    fi

    local tmp_orig tmp_prompt tmp_out tmp_clean
    tmp_orig=$(mktemp); tmp_prompt=$(mktemp); tmp_out=$(mktemp); tmp_clean=$(mktemp)
    printf '%s' "$html" > "$tmp_orig"

    {
      cat <<'PROMPT_HEAD'
You are a book content cleanup tool for TextStack, an online reader.
Below is one chapter's HTML, extracted from a PDF. PDF extraction leaves
structural defects. Fix ONLY structure:

- Remove running headers/footers and stray page numbers that leaked into the
  body (e.g. "<p>Chapter 1: Introduction | 4</p>", "<p>2</p>", "<p>|</p>").
- Rejoin paragraphs fragmented into many one or two word <p> elements.
- Merge words split by a line-wrap hyphen ("chal- lenges" -> "challenges").
- Keep genuine headings as <h2>/<h3>, body text as <p>, lists as <ul>/<ol>.

ABSOLUTE RULES:
- Preserve every word of real content verbatim. Do not summarize, reword,
  translate, correct spelling, or add anything.
- Preserve typography verbatim: smart/curly quotes (“ ” ‘ ’), typographic
  apostrophes (’), em- and en-dashes (— –), and ellipses (…) must NOT be
  normalized to ASCII equivalents. The original characters carry the
  author's intent.
- Preserve all <img> tags exactly, src attribute unchanged.
- Preserve code / monospace content character-for-character.
- Output raw HTML only — no markdown, no code fences, no commentary.

CHAPTER_HTML:
PROMPT_HEAD
      cat "$tmp_orig"
      cat <<'PROMPT_TAIL'

Output exactly, with nothing before or after:
CLEANED_HTML_START
<the cleaned HTML>
CLEANED_HTML_END
PROMPT_TAIL
    } > "$tmp_prompt"

    if ! claude_isolated "$CLEANUP_TIMEOUT" -p --model claude-sonnet-4-6 --permission-mode default \
         < "$tmp_prompt" > "$tmp_out" 2>/dev/null; then
      log "Phase 3: chapter $num — Claude CLI failed/timed out (${CLEANUP_TIMEOUT}s), skipped"
      skipped=$((skipped + 1))
      rm -f "$tmp_orig" "$tmp_prompt" "$tmp_out" "$tmp_clean"; continue
    fi

    # Extract between markers, drop any stray code-fence lines.
    sed -n '/^CLEANED_HTML_START$/,/^CLEANED_HTML_END$/p' "$tmp_out" \
      | sed '1d;$d' | sed '/^```/d' > "$tmp_clean"

    if [ ! -s "$tmp_clean" ]; then
      log "Phase 3: chapter $num — no cleaned HTML parsed, skipped"
      skipped=$((skipped + 1))
      rm -f "$tmp_orig" "$tmp_prompt" "$tmp_out" "$tmp_clean"; continue
    fi

    local gate_verdict
    gate_verdict=$(python3 "$GATE_SCRIPT" "$tmp_orig" "$tmp_clean" 2>/dev/null || echo "REJECT: gate error")

    local pair_file=""
    [ -n "$DATASET_DIR" ] && pair_file="$DATASET_DIR/${target_id}-ch${num}-$(date +%s).json"
    if [[ "$gate_verdict" == ACCEPT* ]]; then
      local esc_html
      esc_html=$(python3 -c "import sys,json; print(json.dumps(open(sys.argv[1],encoding='utf-8').read()))" "$tmp_clean")
      apply_content "$target_type" "$target_id" "$num" "$esc_html"
      cleaned=$((cleaned + 1))
      log "Phase 3: chapter $num cleaned"
      [ -n "$pair_file" ] && log_pair "$pair_file" "$target_id" "$num" true "$tmp_orig" "$tmp_clean" "$gate_verdict"
    else
      rejected=$((rejected + 1))
      log "Phase 3: chapter $num rejected — $gate_verdict"
      [ -n "$pair_file" ] && log_pair "$pair_file" "$target_id" "$num" false "$tmp_orig" "$tmp_clean" "$gate_verdict"
    fi

    rm -f "$tmp_orig" "$tmp_prompt" "$tmp_out" "$tmp_clean"
  done

  update_job_api "$job_id" \
    "{\"contentChaptersCleaned\":$cleaned,\"contentChaptersRejected\":$rejected,\"contentChaptersSkipped\":$skipped}"
  log "Phase 3 done for $book_title: $cleaned cleaned, $rejected rejected, $skipped skipped"
}

# Append a (messy → cleaned) pair to the dataset log — fuel for the heuristic
# ratchet. Best-effort: a logging failure must not fail the cleanup.
log_pair() {
  local file="$1" book_id="$2" chapter="$3" accepted="$4" orig="$5" clean="$6" verdict="$7"
  python3 - "$file" "$book_id" "$chapter" "$accepted" "$orig" "$clean" "$verdict" <<'PY' 2>/dev/null || true
import json, sys, time
file, book_id, chapter, accepted, orig, clean, verdict = sys.argv[1:8]
json.dump({
    "bookId": book_id,
    "chapterNumber": int(chapter),
    "accepted": accepted == "true",
    "verdict": verdict,
    "original": open(orig, encoding="utf-8").read(),
    "cleaned": open(clean, encoding="utf-8").read(),
    "timestamp": time.time(),
}, open(file, "w", encoding="utf-8"), ensure_ascii=False)
PY
}

process_job() {
  local job_id="$1"
  [[ "$job_id" =~ ^[0-9a-f-]{36}$ ]] || { log "Invalid job ID: $job_id"; return 1; }

  # Determine target type
  local edition_id user_book_id target_type target_id book_title
  edition_id=$(db_query "SELECT edition_id FROM book_quality_jobs WHERE id='$job_id'" | tr -d '[:space:]')
  user_book_id=$(db_query "SELECT user_book_id FROM book_quality_jobs WHERE id='$job_id'" | tr -d '[:space:]')

  if [ -n "$edition_id" ] && [ "$edition_id" != "" ]; then
    target_type="edition"
    target_id="$edition_id"
    book_title=$(db_query "SELECT title FROM editions WHERE id='$edition_id'" | head -1)
  elif [ -n "$user_book_id" ] && [ "$user_book_id" != "" ]; then
    target_type="userbook"
    target_id="$user_book_id"
    book_title=$(db_query "SELECT title FROM user_books WHERE id='$user_book_id'" | head -1)
  else
    log "ERROR: Job $job_id has no edition or user book"
    return 1
  fi

  log "Processing quality job $job_id: $book_title ($target_type)"

  # Phase 1: Validate
  update_job_api "$job_id" '{"status":1,"setStartedAt":true}'

  local chapters_json
  chapters_json=$(fetch_chapters "$target_type" "$target_id")

  if [ -z "$chapters_json" ] || [ "$chapters_json" = "[]" ]; then
    update_job_api "$job_id" '{"status":4,"error":"No chapters found","setFinishedAt":true}'
    return 1
  fi

  # Build chapter summary with samples
  local chapter_count
  chapter_count=$(echo "$chapters_json" | python3 -c "import sys,json; print(len(json.load(sys.stdin)))")

  # Get chapter numbers and build summary
  local chapter_summary=""
  local chapter_nums
  chapter_nums=$(echo "$chapters_json" | python3 -c "
import sys, json
chapters = json.load(sys.stdin)
for ch in chapters:
    print(ch['chapterNumber'])
")

  for num in $chapter_nums; do
    local content_json
    content_json=$(fetch_chapter_sample "$target_type" "$target_id" "$num")
    local title wc sample
    title=$(echo "$content_json" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('title',''))" 2>/dev/null || echo "")
    wc=$(echo "$content_json" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('wordCount',0) or 0)" 2>/dev/null || echo "0")
    sample=$(echo "$content_json" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('plainText','')[:300])" 2>/dev/null || echo "")
    chapter_summary="$chapter_summary
{\"chapterNumber\":$num,\"title\":\"$(echo "$title" | sed 's/"/\\"/g')\",\"wordCount\":$wc,\"sample\":\"$(echo "$sample" | tr '\n' ' ' | sed 's/"/\\"/g' | head -c 300)\"}"
  done

  # Get book metadata
  local author_name language
  if [ "$target_type" = "edition" ]; then
    author_name=$(db_query "SELECT a.name FROM authors a JOIN edition_authors ea ON a.id=ea.author_id WHERE ea.edition_id='$target_id' LIMIT 1" | head -1)
    language=$(db_query "SELECT language FROM editions WHERE id='$target_id'" | head -1)
  else
    author_name=$(db_query "SELECT author FROM user_books WHERE id='$target_id'" | head -1)
    language=$(db_query "SELECT language FROM user_books WHERE id='$target_id'" | head -1)
  fi

  log "Validating $chapter_count chapters..."

  local validate_output
  validate_output=$(claude_isolated 300 -p --model claude-sonnet-4-6 --permission-mode default \
    "You are a book quality validator for TextStack, an online book reader.
Analyze this book's chapter structure and report issues.

Book: $book_title
Author: ${author_name:-Unknown}
Language: ${language:-en}
Total chapters: $chapter_count

CHAPTER_LIST:
[$chapter_summary
]

Check for these issues:
1. EMPTY_CHAPTER: wordCount = 0 or < 5
2. FRAGMENT_CHAPTER: wordCount < 50 (just a few words, not a real chapter)
3. GIANT_CHAPTER: wordCount > 30000 (likely needs splitting)
4. PLACEHOLDER_TITLE: title matches 'Section N', 'Chapter N', 'Part N', 'Unknown', 'Untitled', or is just a number
5. DUPLICATE_TITLE: same title appears multiple times
6. TINY_CHAPTER_CLUSTER: 3+ consecutive chapters each under 200 words (bad splits)
7. MISSING_CONTENT: chapter has 0 or near-0 words

For PLACEHOLDER_TITLE: the fix MUST be "rename" with a suggestedTitle — NEVER "delete" (a bad title is not a reason to remove content). Suggest a better title based on the sample content. If content is too short, suggest based on chapter position (Introduction, Epilogue, etc).

Output EXACTLY (no markdown, no commentary):

ISSUES_JSON
[{\"code\":\"ISSUE_CODE\",\"chapterNumber\":N,\"severity\":\"error|warning|info\",\"message\":\"description\",\"fix\":\"delete|rename|merge\",\"suggestedTitle\":\"optional\"}]
ISSUES_END

If no issues found, output:
ISSUES_JSON
[]
ISSUES_END") || {
    log "ERROR: Claude CLI validation failed"
    update_job_api "$job_id" "{\"status\":4,\"error\":\"Claude CLI validation failed\",\"setFinishedAt\":true}"
    return 1
  }

  # Parse issues
  local issues_json
  issues_json=$(echo "$validate_output" | sed -n '/^ISSUES_JSON$/,/^ISSUES_END$/p' | sed '1d;$d')

  # Fallback parsing
  if [ -z "$issues_json" ]; then
    issues_json=$(echo "$validate_output" | grep -A1000 'ISSUES_JSON' | grep -B1000 'ISSUES_END' | sed '1d;$d')
  fi

  if [ -z "$issues_json" ]; then
    log "WARNING: Could not parse issues from Claude output"
    issues_json="[]"
  fi

  local issues_count
  issues_count=$(echo "$issues_json" | python3 -c "import sys,json; print(len(json.load(sys.stdin)))" 2>/dev/null || echo "0")

  log "Found $issues_count issues"

  local esc_issues
  esc_issues=$(echo "$issues_json" | python3 -c "import sys,json; print(json.dumps(sys.stdin.read().strip()))" 2>/dev/null)

  if [ "$issues_count" = "0" ]; then
    update_job_api "$job_id" "{\"status\":2,\"issuesJson\":$esc_issues,\"issuesFound\":0,\"issuesFixed\":0}"
    # Structure is fine — but chapter content can still be poorly extracted.
    run_content_cleanup "$job_id" "$target_type" "$target_id" "$book_title"
    update_job_api "$job_id" "{\"status\":3,\"setFinishedAt\":true}"
    log "No structure issues for: $book_title"
    return 0
  fi

  # Phase 2: Fix
  update_job_api "$job_id" "{\"status\":2,\"issuesJson\":$esc_issues,\"issuesFound\":$issues_count}"

  local fixed_count=0

  # Process fixes in reverse chapter order (highest first) to avoid renumbering conflicts
  # 1. Deletes first
  local delete_nums
  delete_nums=$(echo "$issues_json" | python3 -c "
import sys, json
issues = json.load(sys.stdin)
# Dedup: multiple issues can target the SAME chapter (e.g. FRAGMENT_CHAPTER +
# PLACEHOLDER_TITLE both on ch.1). Without set(), the second delete lands on the
# renumbered NEXT chapter and destroys real content (Ivan Ilyich lost ch. I).
nums = sorted({i['chapterNumber'] for i in issues if i.get('fix') == 'delete'}, reverse=True)
for n in nums:
    print(n)
" 2>/dev/null)

  for num in $delete_nums; do
    log "Deleting chapter $num"
    apply_delete "$target_type" "$target_id" "$num"
    fixed_count=$((fixed_count + 1))
  done

  # 2. Merges (process clusters from last to first)
  local merge_groups
  merge_groups=$(echo "$issues_json" | python3 -c "
import sys, json
issues = json.load(sys.stdin)
merge_issues = [i for i in issues if i.get('fix') == 'merge']
if not merge_issues:
    sys.exit(0)
# Group consecutive chapter numbers
groups = []
current = []
for i in sorted(merge_issues, key=lambda x: x['chapterNumber']):
    if current and i['chapterNumber'] != current[-1] + 1:
        if len(current) >= 2:
            groups.append(current)
        current = []
    current.append(i['chapterNumber'])
if len(current) >= 2:
    groups.append(current)
# Output groups in reverse order
for g in reversed(groups):
    print(json.dumps(g))
" 2>/dev/null)

  for group in $merge_groups; do
    log "Merging chapters: $group"
    apply_merge "$target_type" "$target_id" "$group"
    fixed_count=$((fixed_count + 1))
  done

  # 3. Renames
  local rename_entries
  rename_entries=$(echo "$issues_json" | python3 -c "
import sys, json
issues = json.load(sys.stdin)
renames = [(i['chapterNumber'], i.get('suggestedTitle', '')) for i in issues if i.get('fix') == 'rename' and i.get('suggestedTitle')]
for num, title in renames:
    print(f'{num}|||{title}')
" 2>/dev/null)

  while IFS= read -r entry; do
    [ -z "$entry" ] && continue
    local num title
    num=$(echo "$entry" | cut -d'|' -f1)
    title=$(echo "$entry" | cut -d'|' -f4-)
    if [ -n "$num" ] && [ -n "$title" ]; then
      log "Renaming chapter $num to: $title"
      apply_rename "$target_type" "$target_id" "$num" "$title"
      fixed_count=$((fixed_count + 1))
    fi
  done <<< "$rename_entries"

  update_job_api "$job_id" "{\"issuesFixed\":$fixed_count}"

  # Phase 3 — content cleanup, after structure fixes have renumbered chapters.
  run_content_cleanup "$job_id" "$target_type" "$target_id" "$book_title"

  # Store log
  local log_text
  log_text="Validated $chapter_count chapters. Found $issues_count issues, fixed $fixed_count."
  local esc_log
  esc_log=$(echo "$log_text" | python3 -c "import sys,json; print(json.dumps(sys.stdin.read().strip()))")

  update_job_api "$job_id" "{\"status\":3,\"logOutput\":$esc_log,\"setFinishedAt\":true}"
  log "Completed: $book_title — $issues_count issues found, $fixed_count fixed"
}

# Main loop
log "Book Quality poller started (repo: $REPO_DIR)"
while true; do
  job_id=$(db_query "SELECT id FROM book_quality_jobs WHERE status = $STATUS_QUEUED ORDER BY created_at LIMIT 1" | tr -d '[:space:]')

  if [ -n "$job_id" ]; then
    process_job "$job_id" || {
      log "Job $job_id failed"
      update_job_api "$job_id" "{\"status\":4,\"error\":\"Script failed unexpectedly\",\"setFinishedAt\":true}"
    }
  fi

  sleep "$POLL_INTERVAL"
done
