import { SUBJECT } from "@/lib/terminology";

/** A subject's page, named for the deployment: `/patients/<id>` on a patient deployment,
 *  `/employees/<id>` otherwise (#648). Both routes serve the same page, so an old link still opens. */
export function subjectPath(externalId: string): string {
  return `/${SUBJECT.plural}/${encodeURIComponent(externalId)}`;
}
