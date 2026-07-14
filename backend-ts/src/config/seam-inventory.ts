/**
 * Inert-seam inventory + boot-time active-seam log line (#260/#264).
 *
 * The repo has 9 "inert-unless-configured" seams (ADR-011/012/013/017/023/025/029/030 + #264 alert webhook):
 * each has a simulated or store-backed default and an inert/stub adapter that only activates when its
 * env var(s) are set. Individually each is correct and reviewed; collectively they're untested-in-anger
 * surface that can rot silently (a var typo'd in a deploy secret, a seam nobody remembers exists). This
 * module is the cheap insurance: a single pure `describeSeams(env)` that reports each seam's
 * active/inactive state, derived by CALLING the exact predicate each seam's own `resolve*` function
 * already uses — never a second copy of the env-var parsing. A boot log line (worker.ts) makes the
 * deployed configuration observable without duplicating the resolver logic.
 *
 * Note: the alert *console* channel is always-on (not an inert seam); only the optional webhook is
 * inventory-tracked as `alert-webhook`.
 *
 * Descriptive only: this module makes NO decisions and NEVER selects a seam — it just reports what
 * the existing resolvers would decide. No behavior change (ADR-008 n/a — nothing here touches
 * compliance).
 */
import { isSendgridConfigured, type EmailEnv } from "../case/email-service.ts";
import { isS3BucketConfigured, type BucketSeamEnv } from "../case/resolve-bucket.ts";
import { isDataChaserConfigured, type ChannelEnv } from "../case/outreach-channel.ts";
import { isIceConfigured, type ForecastEnv } from "../engine/immunization/immunization-forecast.ts";
import { isEhFhirConfigured, type StandingOrderEnv } from "../order/standing-order-provider.ts";
import { isWebChartConfigured, type DataSourceEnv } from "../engine/ingress/data-source.ts";
import { isSqlPushdownSelected, type MeasureExecutorEnv } from "../engine/measure-executor.ts";
import { isVsacConfigured, type VsacEnv } from "../engine/cql/resolve-value-set-resolver.ts";
import { isAlertWebhookConfigured, type AlertEnv } from "../run/alert-channel.ts";

/** The union of every seam's env-var shape (all optional — assignable from the worker's `Env`). */
export type SeamEnv = EmailEnv &
  ChannelEnv &
  ForecastEnv &
  StandingOrderEnv &
  DataSourceEnv &
  MeasureExecutorEnv &
  VsacEnv &
  AlertEnv &
  BucketSeamEnv;

export interface SeamStatus {
  /** Short, stable, log-line-friendly seam name. */
  name: string;
  active: boolean;
}

/**
 * Reports the active/inactive state of every inert-unless-configured seam, in the fixed order the
 * boot log line uses. Pure — no I/O, no DB, no side effects; safe to call on every boot.
 */
export function describeSeams(env: SeamEnv): SeamStatus[] {
  return [
    { name: "sendgrid", active: isSendgridConfigured(env) },
    { name: "datachaser", active: isDataChaserConfigured(env) },
    { name: "ice", active: isIceConfigured(env) },
    { name: "eh-fhir", active: isEhFhirConfigured(env) },
    { name: "webchart", active: isWebChartConfigured(env) },
    { name: "sql-executor", active: isSqlPushdownSelected(env) },
    { name: "vsac", active: isVsacConfigured(env) },
    { name: "alert-webhook", active: isAlertWebhookConfigured(env) },
    { name: "bucket-s3", active: isS3BucketConfigured(env) },
  ];
}

/** Formats the boot log line: `seams: sendgrid=off … vsac=off alert-webhook=off`. */
export function formatSeamLogLine(env: SeamEnv): string {
  const parts = describeSeams(env).map((s) => `${s.name}=${s.active ? "on" : "off"}`);
  return `seams: ${parts.join(" ")}`;
}
