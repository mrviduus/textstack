-- Undoes 0006_drop_ssg_rebuild_results: recreates the table empty, as 0000_baseline has it. Rows
-- come from a backup (see the up header).

SET LOCAL lock_timeout = '5s';

CREATE TABLE public.ssg_rebuild_results (
    id uuid NOT NULL,
    job_id uuid NOT NULL,
    route character varying(500) NOT NULL,
    route_type character varying(20) NOT NULL,
    success boolean NOT NULL,
    render_time_ms integer,
    error text,
    rendered_at timestamp with time zone NOT NULL
);
ALTER TABLE ONLY public.ssg_rebuild_results
    ADD CONSTRAINT pk_ssg_rebuild_results PRIMARY KEY (id);
CREATE INDEX ix_ssg_rebuild_results_job_id ON public.ssg_rebuild_results USING btree (job_id);
CREATE UNIQUE INDEX ix_ssg_rebuild_results_job_id_route ON public.ssg_rebuild_results USING btree (job_id, route);
ALTER TABLE ONLY public.ssg_rebuild_results
    ADD CONSTRAINT fk_ssg_rebuild_results_ssg_rebuild_jobs_job_id FOREIGN KEY (job_id) REFERENCES public.ssg_rebuild_jobs(id) ON DELETE CASCADE;
