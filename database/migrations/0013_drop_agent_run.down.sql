-- Undoes 0013_drop_agent_run: the table back, EMPTY, as 0000 left it.

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
