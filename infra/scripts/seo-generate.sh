#!/bin/bash
# Generates SEO content for an edition or author using Claude CLI.
# Usage: ./infra/scripts/seo-generate.sh <edition|author> <entity-id>
# Requires: claude CLI (Max subscription), docker (for psql via db container).

set -euo pipefail

MODE="$1"
ENTITY_ID="$2"

if [ -z "$MODE" ] || [ -z "$ENTITY_ID" ]; then
  echo "Usage: $0 <edition|author> <entity-uuid>"
  exit 1
fi

REPO_DIR="$(cd "$(dirname "$0")/../.." && pwd)"

# Load .env. Validate first — bash `source` on a malformed file (e.g. a
# stray `KEY = value` with spaces around `=`) silently runs the LHS as a
# command, fails with "command not found", and `set -e` then kills us
# inside <1s before claude is even invoked. This bit us 2026-04 → 2026-05
# when a hand-edit added spaces to OPENAI_API_KEY's line. Fail loud, fail
# specific.
if [ -f "$REPO_DIR/.env" ]; then
  bad_lines=$(grep -nE '^[[:space:]]*[A-Za-z_][A-Za-z0-9_]*[[:space:]]+=|^[[:space:]]*[A-Za-z_][A-Za-z0-9_]*=[[:space:]]' "$REPO_DIR/.env" || true)
  if [ -n "$bad_lines" ]; then
    echo "ERROR: $REPO_DIR/.env has KEY = VALUE with whitespace around '=' — bash source will fail. Fix these lines:" >&2
    echo "$bad_lines" | sed 's/=.*/=<redacted>/' >&2
    exit 1
  fi
  set -a
  source "$REPO_DIR/.env"
  set +a
fi

for var in POSTGRES_USER POSTGRES_DB; do
  if [ -z "${!var:-}" ]; then
    echo "ERROR: $var not set" >&2
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

# stderr NOT suppressed — psql ERRORs (bad column, connection drop) propagate
# to the script's stderr → journalctl. Earlier 2>/dev/null silently dropped
# them, which is how the `sort_order` typo killed 1,153 jobs over 3 weeks
# without a single visible error message anywhere.
db_query() {
  docker compose -f "$REPO_DIR/docker-compose.yml" exec -T db \
    psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "$1"
}

# Strict variant for fields that MUST exist. Fails the script (returns
# non-zero) on either a psql error OR an empty result. Caller writes:
#
#   local title; title=$(db_query_required "title" "SELECT ...") || return 1
#
# DO NOT collapse to `local title=$(...)` — `local` always returns 0 and
# masks the inner exit code (classic bash gotcha), defeating set -e and
# this helper's whole purpose.
db_query_required() {
  local label="$1" sql="$2" result
  if ! result=$(db_query "$sql"); then
    log "ERROR: query failed [$label]"
    return 1
  fi
  if [ -z "$result" ]; then
    log "ERROR: empty result [$label]: ${sql:0:120}…"
    return 1
  fi
  printf '%s' "$result"
}

# Same shape as db_query but for INSERT/UPDATE/DELETE — surfaces psql errors
# instead of swallowing them, so a column rename in an UPDATE doesn't make
# the script claim success on a no-op.
db_exec() {
  docker compose -f "$REPO_DIR/docker-compose.yml" exec -T db \
    psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "$1"
}

escape_sql() {
  echo "$1" | sed "s/'/''/g"
}

generate_edition_seo() {
  local id="$1"

  # `db_query | head -1` was the historical pattern but `head -1` closes the
  # pipe after the first line; for multi-line values like plain_text excerpts
  # that triggers SIGPIPE on psql, which `set -o pipefail` then propagates as
  # a non-zero pipeline exit, killing the script via `set -e`. The queries
  # already return one row each (LIMIT 1 / pk lookup), so just take the row.
  #
  # Required fields use db_query_required: failing-loud on either a psql
  # error or an empty result. Optional fields (author) use db_query.
  local title author lang excerpt
  title=$(db_query_required "title"   "SELECT title FROM editions WHERE id='$id'") || return 1
  lang=$(db_query_required  "lang"    "SELECT language FROM editions WHERE id='$id'") || return 1
  excerpt=$(db_query_required "excerpt" "SELECT LEFT(plain_text, 1000) FROM chapters WHERE edition_id='$id' ORDER BY chapter_number LIMIT 1") || return 1
  author=$(db_query "SELECT a.name FROM authors a JOIN edition_authors ea ON a.id = ea.author_id WHERE ea.edition_id='$id' LIMIT 1") || true

  log "Generating SEO for edition: $title by $author ($lang)"

  local output
  output=$(claude_isolated 300 -p --model claude-sonnet-4-6 --permission-mode default \
    "You are an SEO content writer for TextStack, a free online book library.

Generate SEO content for this book. Write in the SAME LANGUAGE as the book.

Book: $title
Author: $author
Language: $lang
First chapter excerpt: $excerpt

Rules:
- Factual, encyclopedic tone
- No subjective superlatives
- Themes as noun phrases (e.g. \"Guilt and redemption\" not \"Explores guilt\")
- FAQs: practical questions, mention TextStack where appropriate
- Write in the same language as the book ($lang)

Output EXACTLY in this format (no markdown fences, no extra commentary):

DESCRIPTION_START
[150-250 word plot summary + literary significance]
DESCRIPTION_END

RELEVANCE_START
[100-150 words: modern connections, cultural influence, why readers today should care]
RELEVANCE_END

THEMES_JSON
[\"Theme 1\", \"Theme 2\", \"Theme 3\", \"Theme 4\", \"Theme 5\"]

FAQS_JSON
[{\"question\":\"What is $title about?\",\"answer\":\"...\"}, {\"question\":\"Is $title difficult to read?\",\"answer\":\"...\"}, {\"question\":\"How long does it take to read $title?\",\"answer\":\"...\"}, {\"question\":\"What are the main themes in $title?\",\"answer\":\"...\"}]") || {
    log "ERROR: Claude CLI failed for edition $id"
    return 1
  }

  # Parse sections
  local description relevance themes faqs
  description=$(echo "$output" | sed -n '/DESCRIPTION_START/,/DESCRIPTION_END/p' | sed '1d;$d')
  relevance=$(echo "$output" | sed -n '/RELEVANCE_START/,/RELEVANCE_END/p' | sed '1d;$d')
  themes=$(echo "$output" | sed -n '/^THEMES_JSON$/,/^$/p' | sed '1d' | head -1)
  faqs=$(echo "$output" | sed -n '/^FAQS_JSON$/,/^$/p' | sed '1d')

  # Fallback: try inline parsing if section markers didn't work
  if [ -z "$themes" ]; then
    themes=$(echo "$output" | grep -A1 'THEMES_JSON' | tail -1)
  fi
  if [ -z "$faqs" ]; then
    faqs=$(echo "$output" | sed -n '/FAQS_JSON/,$ p' | tail -n +2)
  fi

  # Validate
  if [ -z "$description" ] || [ -z "$relevance" ] || [ -z "$themes" ]; then
    log "ERROR: Failed to parse SEO output for edition $id"
    log "Output: $(echo "$output" | head -20)"
    return 1
  fi

  # Update DB
  local esc_desc esc_rel esc_themes esc_faqs
  esc_desc=$(escape_sql "$description")
  esc_rel=$(escape_sql "$relevance")
  esc_themes=$(escape_sql "$themes")
  esc_faqs=$(escape_sql "$faqs")

  if ! db_exec "UPDATE editions SET
    description = '$esc_desc',
    seo_relevance_text = '$esc_rel',
    seo_themes_json = '$esc_themes',
    seo_faqs_json = '$esc_faqs',
    updated_at = NOW()
    WHERE id = '$id';" >/dev/null; then
    log "ERROR: UPDATE editions failed for $id"
    return 1
  fi

  log "Edition SEO updated: $title"
}

generate_author_seo() {
  local id="$1"

  local name books lang
  name=$(db_query_required "name" "SELECT name FROM authors WHERE id='$id'") || return 1
  books=$(db_query "SELECT string_agg(e.title, ', ' ORDER BY e.title) FROM editions e JOIN edition_authors ea ON e.id = ea.edition_id WHERE ea.author_id='$id' AND e.status = 1") || true
  lang=$(db_query "SELECT COALESCE(e.language, 'en') FROM editions e JOIN edition_authors ea ON e.id = ea.edition_id WHERE ea.author_id='$id' LIMIT 1") || true

  log "Generating SEO for author: $name ($lang)"

  local output
  output=$(claude_isolated 300 -p --model claude-sonnet-4-6 --permission-mode default \
    "You are an SEO content writer for TextStack, a free online book library.

Generate SEO content for this author. Write in the SAME LANGUAGE indicated below.

Author: $name
Published books on TextStack: $books
Language: ${lang:-en}

Rules:
- Factual, encyclopedic tone
- Include birth/death years if known
- Mention major works and achievements
- No subjective superlatives
- Themes as noun phrases
- Write in language: ${lang:-en}

Output EXACTLY in this format (no markdown fences, no extra commentary):

BIO_START
[200-400 word biography: life, major works, literary style, influence]
BIO_END

RELEVANCE_START
[100-200 words: modern connections, adaptations, cultural influence]
RELEVANCE_END

THEMES_JSON
[\"Theme 1\", \"Theme 2\", \"Theme 3\", \"Theme 4\", \"Theme 5\"]

FAQS_JSON
[{\"question\":\"Who was $name?\",\"answer\":\"...\"}, {\"question\":\"What are the most famous works by $name?\",\"answer\":\"...\"}, {\"question\":\"Why is $name still relevant today?\",\"answer\":\"...\"}, {\"question\":\"Where can I read books by $name online?\",\"answer\":\"...\"}]") || {
    log "ERROR: Claude CLI failed for author $id"
    return 1
  }

  # Parse sections
  local bio relevance themes faqs
  bio=$(echo "$output" | sed -n '/BIO_START/,/BIO_END/p' | sed '1d;$d')
  relevance=$(echo "$output" | sed -n '/RELEVANCE_START/,/RELEVANCE_END/p' | sed '1d;$d')
  themes=$(echo "$output" | sed -n '/^THEMES_JSON$/,/^$/p' | sed '1d' | head -1)
  faqs=$(echo "$output" | sed -n '/^FAQS_JSON$/,/^$/p' | sed '1d')

  if [ -z "$themes" ]; then
    themes=$(echo "$output" | grep -A1 'THEMES_JSON' | tail -1)
  fi
  if [ -z "$faqs" ]; then
    faqs=$(echo "$output" | sed -n '/FAQS_JSON/,$ p' | tail -n +2)
  fi

  # Validate
  if [ -z "$bio" ] || [ -z "$relevance" ] || [ -z "$themes" ]; then
    log "ERROR: Failed to parse SEO output for author $id"
    log "Output: $(echo "$output" | head -20)"
    return 1
  fi

  # Update DB
  local esc_bio esc_rel esc_themes esc_faqs
  esc_bio=$(escape_sql "$bio")
  esc_rel=$(escape_sql "$relevance")
  esc_themes=$(escape_sql "$themes")
  esc_faqs=$(escape_sql "$faqs")

  if ! db_exec "UPDATE authors SET
    bio = '$esc_bio',
    seo_relevance_text = '$esc_rel',
    seo_themes_json = '$esc_themes',
    seo_faqs_json = '$esc_faqs',
    updated_at = NOW()
    WHERE id = '$id';" >/dev/null; then
    log "ERROR: UPDATE authors failed for $id"
    return 1
  fi

  log "Author SEO updated: $name"
}

# Main
case "$MODE" in
  edition) generate_edition_seo "$ENTITY_ID" ;;
  author)  generate_author_seo "$ENTITY_ID" ;;
  *) echo "Unknown mode: $MODE. Use 'edition' or 'author'."; exit 1 ;;
esac
