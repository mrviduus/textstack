-- Undoes 0012_drop_review_question_and_agent_run: both tables back, EMPTY, as 0000 and 0001 left them
-- (review_question's FK follows an UPDATE of user_id; its prompt index keyed by user_id). Their rows come
-- only from a backup taken before 0012.

CREATE TABLE public.review_question (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    book_insight_id uuid NOT NULL,
    block_index integer NOT NULL,
    prompt varchar(500) NOT NULL,
    answer varchar(1500) NOT NULL,
    prompt_hash varchar(16) NOT NULL,
    stage integer NOT NULL,
    interval_days double precision NOT NULL,
    consecutive_correct integer NOT NULL,
    next_review_at timestamptz NOT NULL,
    last_reviewed_at timestamptz,
    total_reviews integer NOT NULL,
    correct_reviews integer NOT NULL,
    is_retired boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    CONSTRAINT pk_review_question PRIMARY KEY (id),
    CONSTRAINT ck_review_question_stage CHECK (stage >= 0),
    CONSTRAINT ck_review_question_interval_days CHECK (interval_days >= 0),
    CONSTRAINT ck_review_question_consecutive_correct CHECK (consecutive_correct >= 0),
    CONSTRAINT fk_review_question_book_insight_user_id_book_insight_id FOREIGN KEY (user_id, book_insight_id)
        REFERENCES public.book_insight (user_id, id) ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX ix_review_question_user_id_book_insight_id_prompt_hash
    ON public.review_question (user_id, book_insight_id, prompt_hash);
CREATE INDEX ix_review_question_user_id_is_retired_next_review_at ON public.review_question (user_id, is_retired, next_review_at);
COMMENT ON TABLE public.review_question IS
    'Discussion. A self-check question of a chapter review (book_insight), with its review schedule.';

CREATE TABLE public.agent_run (
    id uuid NOT NULL,
    agent varchar(64) NOT NULL,
    user_id uuid,
    goal text NOT NULL,
    status varchar(32) NOT NULL,
    output text,
    steps_json jsonb NOT NULL,
    iterations integer NOT NULL,
    tokens_in integer NOT NULL,
    tokens_out integer NOT NULL,
    cost_usd numeric(10,6) NOT NULL,
    latency_ms integer NOT NULL,
    error text,
    created_at timestamptz NOT NULL,
    confidence double precision,
    tool_calls_count integer NOT NULL DEFAULT 0,
    CONSTRAINT pk_agent_run PRIMARY KEY (id),
    CONSTRAINT ck_agent_run_status CHECK (status IN ('completed', 'budget_exhausted', 'error')),
    CONSTRAINT fk_agent_run_users_user_id FOREIGN KEY (user_id)
        REFERENCES public.users (id) ON DELETE CASCADE
);
CREATE INDEX ix_agent_run_user_id_created_at ON public.agent_run (user_id, created_at) WHERE user_id IS NOT NULL;
COMMENT ON TABLE public.agent_run IS
    'Ops. One agent run with its steps; a user''s runs go with the account.';
