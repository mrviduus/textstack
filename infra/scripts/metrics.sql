\pset footer off
\pset border 2

\echo '=== 1. USERS ==='
SELECT
  COUNT(*) FILTER (WHERE is_guest = false)                     AS registered,
  COUNT(*) FILTER (WHERE is_guest = true)                      AS guests,
  COUNT(*) FILTER (WHERE is_guest = false AND google_subject IS NOT NULL AND google_subject <> '') AS google_auth,
  COUNT(*) FILTER (WHERE is_guest = false AND apple_subject IS NOT NULL)                           AS apple_auth,
  COUNT(*) FILTER (WHERE is_guest = false AND password_hash IS NOT NULL)                           AS email_auth,
  COUNT(*)                                                     AS total
FROM users;

\echo
\echo '=== 2. USER GROWTH (registered, by month) ==='
WITH by_month AS (
  SELECT date_trunc('month', created_at)::date AS month, COUNT(*) AS new_users
  FROM users WHERE is_guest = false GROUP BY 1
)
SELECT month, new_users, SUM(new_users) OVER (ORDER BY month) AS cumulative
FROM by_month ORDER BY month;

\echo
\echo '=== 3. ACTIVE USERS (last_active_at) ==='
SELECT
  COUNT(*) FILTER (WHERE last_active_at > now() - interval '1 day')  AS dau,
  COUNT(*) FILTER (WHERE last_active_at > now() - interval '7 days') AS wau,
  COUNT(*) FILTER (WHERE last_active_at > now() - interval '30 days') AS mau
FROM users
WHERE is_guest = false;

\echo
\echo '=== 4. ACTIVE USERS (reading_sessions, stricter) ==='
SELECT
  COUNT(DISTINCT user_id) FILTER (WHERE started_at > now() - interval '1 day')  AS dau_readers,
  COUNT(DISTINCT user_id) FILTER (WHERE started_at > now() - interval '7 days') AS wau_readers,
  COUNT(DISTINCT user_id) FILTER (WHERE started_at > now() - interval '30 days') AS mau_readers
FROM reading_sessions;

\echo
\echo '=== 5. READING ACTIVITY (all-time) ==='
SELECT
  COUNT(*)                                   AS sessions,
  COUNT(DISTINCT user_id)                    AS readers,
  ROUND(SUM(duration_seconds) / 3600.0, 1)   AS hours_total,
  SUM(words_read)                            AS words_read_total,
  ROUND(AVG(duration_seconds) / 60.0, 1)     AS avg_minutes_per_session
FROM reading_sessions;

\echo
\echo '=== 6. READING ACTIVITY (last 30 days) ==='
SELECT
  date_trunc('day', started_at)::date        AS day,
  COUNT(DISTINCT user_id)                    AS unique_readers,
  COUNT(*)                                   AS sessions,
  ROUND(SUM(duration_seconds) / 3600.0, 1)   AS hours
FROM reading_sessions
WHERE started_at > now() - interval '30 days'
GROUP BY 1
ORDER BY 1 DESC;

\echo
\echo '=== 7. CONTENT ==='
SELECT
  (SELECT COUNT(*) FROM works)                                       AS works,
  (SELECT COUNT(*) FROM editions)                                    AS editions_total,
  (SELECT COUNT(*) FROM editions WHERE status = 0)                   AS editions_draft,
  (SELECT COUNT(*) FROM editions WHERE status = 1)                   AS editions_published,
  (SELECT COUNT(*) FROM editions WHERE status = 2)                   AS editions_hidden,
  (SELECT COUNT(*) FROM chapters)                                    AS chapters,
  (SELECT COUNT(*) FROM authors)                                     AS authors;

\echo
\echo '=== 8. USER-UPLOADED BOOKS ==='
SELECT
  COUNT(*)                                        AS total_user_books,
  COUNT(DISTINCT user_id)                         AS uploaders,
  COUNT(*) FILTER (WHERE created_at > now() - interval '30 days') AS last_30d
FROM user_books;

\echo
\echo '=== 9. VOCABULARY (total) ==='
SELECT
  COUNT(*)                                  AS words_saved,
  COUNT(DISTINCT user_id)                   AS vocab_learners,
  COUNT(*) FILTER (WHERE stage = 0)         AS stage_new,
  COUNT(*) FILTER (WHERE stage = 1)         AS stage_recognition,
  COUNT(*) FILTER (WHERE stage = 2)         AS stage_recall,
  COUNT(*) FILTER (WHERE stage = 3)         AS stage_context,
  COUNT(*) FILTER (WHERE stage = 4)         AS stage_mastered,
  COUNT(*) FILTER (WHERE is_retired = true) AS retired
FROM vocabulary_words;

\echo
\echo '=== 10. VOCABULARY REVIEWS (last 30 days) ==='
SELECT
  COUNT(*)                               AS reviews_30d,
  COUNT(DISTINCT user_id)                AS reviewers_30d,
  ROUND(100.0 * AVG(CASE WHEN is_correct THEN 1 ELSE 0 END), 1) AS pct_correct,
  ROUND(AVG(response_time_ms) / 1000.0, 1) AS avg_response_sec
FROM vocabulary_reviews
WHERE created_at > now() - interval '30 days';

\echo
\echo '=== 11. ANNOTATIONS ==='
SELECT
  (SELECT COUNT(*) FROM highlights) AS highlights,
  (SELECT COUNT(*) FROM bookmarks)  AS bookmarks;

\echo
\echo '=== 12. RETENTION (weekly cohorts, registered users) ==='
WITH cohorts AS (
  SELECT id, date_trunc('week', created_at) AS cohort_week
  FROM users WHERE is_guest = false
),
activity AS (
  SELECT DISTINCT user_id, date_trunc('week', started_at) AS active_week
  FROM reading_sessions
)
SELECT
  c.cohort_week::date AS cohort,
  COUNT(DISTINCT c.id) AS size,
  COUNT(DISTINCT CASE WHEN a.active_week = c.cohort_week + interval '1 week' THEN c.id END) AS w1,
  COUNT(DISTINCT CASE WHEN a.active_week = c.cohort_week + interval '2 weeks' THEN c.id END) AS w2,
  COUNT(DISTINCT CASE WHEN a.active_week = c.cohort_week + interval '4 weeks' THEN c.id END) AS w4
FROM cohorts c
LEFT JOIN activity a ON a.user_id = c.id
GROUP BY 1
ORDER BY 1 DESC
LIMIT 12;
