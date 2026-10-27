-- Undoes 0007_drop_shadow_runs: recreates the table empty, as 0000_baseline has it. Rows come from
-- a backup (see the up header); there were none.

SET LOCAL lock_timeout = '5s';

CREATE TABLE public.shadow_runs (
    id uuid NOT NULL,
    feature_tag character varying(64) NOT NULL,
    primary_model_id character varying(128) NOT NULL,
    shadow_model_id character varying(128) NOT NULL,
    primary_response text,
    shadow_response text,
    primary_latency_ms integer NOT NULL,
    shadow_latency_ms integer NOT NULL,
    primary_cost_usd numeric(10,6) NOT NULL,
    shadow_cost_usd numeric(10,6) NOT NULL,
    primary_tokens_in integer NOT NULL,
    primary_tokens_out integer NOT NULL,
    shadow_tokens_in integer NOT NULL,
    shadow_tokens_out integer NOT NULL,
    primary_trace_id uuid,
    shadow_trace_id uuid,
    prompt_hash character varying(64) NOT NULL,
    user_id uuid,
    created_at timestamp with time zone NOT NULL
);
ALTER TABLE ONLY public.shadow_runs
    ADD CONSTRAINT pk_shadow_runs PRIMARY KEY (id);
CREATE INDEX ix_shadow_runs_feature_tag_created_at ON public.shadow_runs USING btree (feature_tag, created_at);
CREATE INDEX ix_shadow_runs_user_id ON public.shadow_runs USING btree (user_id) WHERE (user_id IS NOT NULL);
ALTER TABLE ONLY public.shadow_runs
    ADD CONSTRAINT fk_shadow_runs_users_user_id FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE SET NULL;
