import type { Job, JobStatus, Rating } from "@/lib/db/schema";

/**
 * One scored job, flattened for display.
 *
 * The feed reads these out of Postgres and Find jobs gets them back from the
 * search action, so both need a shape that is plain, serialisable data and
 * belongs to neither. Without it the two screens drift into showing the same
 * job two different ways.
 */
export type JobView = {
  id: string;
  title: string;
  company: string;
  location: string;
  source: string;
  url: string;
  salary: string;
  postedAt: string;
  companyUrl: string;
  remote: boolean;
  score: number;
  verdict: string;
  whyPick: string[];
  concerns: string[];
  missingSkills: string[];
  status: JobStatus | null;
};

export function toJobView(job: Job, rating: Rating, status: JobStatus | null): JobView {
  return {
    id: job.id,
    title: job.title,
    company: job.company,
    location: job.location,
    source: job.source,
    url: job.url,
    salary: job.salary,
    postedAt: job.postedAt,
    companyUrl: job.companyUrl,
    remote: job.remote,
    score: rating.score,
    verdict: rating.verdict,
    whyPick: rating.whyPick,
    concerns: rating.concerns,
    missingSkills: rating.missingSkills,
    status,
  };
}
