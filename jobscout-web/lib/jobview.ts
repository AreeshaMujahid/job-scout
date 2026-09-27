import type { Job, JobStatus, Rating } from "@/lib/db/schema";
import { sponsorship, yearsRequired, type SponsorshipSignal } from "@/lib/signals";

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
  /** The board's own logo for the employer, or "" when it sent none. */
  logoUrl: string;
  remote: boolean;
  score: number;
  verdict: string;
  /**
   * The three parts the overall score is made of.
   *
   * Stored since the first release and never shown, which made the score a
   * number you either trusted or did not. Broken out, an 88 that is
   * "skills 100, experience 100, domain 64" tells you the gap is the
   * industry rather than you -- and that is a different decision.
   */
  skillsMatch: number;
  experienceMatch: number;
  domainMatch: number;
  /** Skills the CV has that this posting asks for, and the ones it does not. */
  matchedSkills: string[];
  /** The board's own topic labels for the posting. Often empty. */
  tags: string[];
  /** One line on why this job, written when it was scored. */
  pitch: string;
  whyPick: string[];
  concerns: string[];
  missingSkills: string[];
  status: JobStatus | null;
  /**
   * Facts the posting states about itself, read once here rather than in the
   * card. The card is a client component; handing it a whole job description
   * to scan on every render would ship the text of every posting in the feed
   * to the browser to compute two small booleans.
   */
  sponsorship: SponsorshipSignal;
  yearsRequired: number | null;
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
    logoUrl: job.logoUrl,
    remote: job.remote,
    score: rating.score,
    verdict: rating.verdict,
    skillsMatch: rating.skillsMatch,
    experienceMatch: rating.experienceMatch,
    domainMatch: rating.domainMatch,
    matchedSkills: rating.matchedSkills,
    tags: job.tags,
    pitch: rating.pitch,
    whyPick: rating.whyPick,
    concerns: rating.concerns,
    missingSkills: rating.missingSkills,
    status,
    sponsorship: sponsorship(job.description),
    yearsRequired: yearsRequired(job.description),
  };
}
