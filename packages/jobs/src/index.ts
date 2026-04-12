import { nowIso, toJobId, type ArtifactId, type JobId, type JobRecord, type ProjectId } from '@openzcad/shared';

export interface ComputeProvider {
  execute<TPayload, TResult>(kind: string, payload: TPayload): Promise<TResult>;
}

export interface JobRunner {
  enqueue(input: {
    kind: JobRecord['kind'];
    projectId: ProjectId;
    artifactId?: ArtifactId;
  }): Promise<JobRecord>;
  runLocal<TPayload, TResult>(kind: string, payload: TPayload): Promise<TResult>;
}

export class LocalComputeProvider implements ComputeProvider {
  async execute<TPayload, TResult>(_kind: string, payload: TPayload): Promise<TResult> {
    return payload as unknown as TResult;
  }
}

export class InMemoryJobRunner implements JobRunner {
  private readonly jobs = new Map<JobId, JobRecord>();

  constructor(private readonly provider: ComputeProvider = new LocalComputeProvider()) {}

  async enqueue(input: {
    kind: JobRecord['kind'];
    projectId: ProjectId;
    artifactId?: ArtifactId;
  }): Promise<JobRecord> {
    const time = nowIso();
    const job: JobRecord = {
      jobId: toJobId(`job_${crypto.randomUUID()}`),
      kind: input.kind,
      status: 'queued',
      projectId: input.projectId,
      createdAt: time,
      updatedAt: time
    };
    if (input.artifactId) {
      job.artifactId = input.artifactId;
    }
    this.jobs.set(job.jobId, job);
    return job;
  }

  async runLocal<TPayload, TResult>(kind: string, payload: TPayload): Promise<TResult> {
    return this.provider.execute<TPayload, TResult>(kind, payload);
  }
}
