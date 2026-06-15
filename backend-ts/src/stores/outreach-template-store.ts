/**
 * OutreachTemplateStore contract (#108 admin write CRUD) — the DB-backed outreach message
 * templates. Mirrors the canonical `outreach_templates` table (V007). Replaces the earlier
 * built-in single-default template with a persisted, seedable set that supports create + update
 * from the Admin → Outreach Templates surface.
 */
export interface OutreachTemplateRecord {
  id: string;
  name: string;
  subject: string;
  bodyText: string;
  type: string;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  active: boolean;
}

export interface SeedTemplateInput {
  id: string;
  name: string;
  subject: string;
  bodyText: string;
  type: string;
  createdBy: string;
}

export interface CreateTemplateInput {
  id: string;
  name: string;
  subject: string;
  bodyText: string;
  type: string;
  createdBy: string;
}

export interface UpdateTemplateInput {
  name: string;
  subject: string;
  bodyText: string;
  type: string;
  active: boolean;
}

export interface OutreachTemplateStore {
  /** True when no templates exist (the demo-seed guard). */
  isEmpty(): Promise<boolean>;
  /** Insert a demo template by fixed id (ON CONFLICT DO NOTHING). */
  seed(input: SeedTemplateInput): Promise<void>;
  /** Active templates, newest-first (created_at DESC, name ASC) — Java listTemplates. */
  listActive(): Promise<OutreachTemplateRecord[]>;
  /** Any template by id (active or not); null if unknown. */
  getById(id: string): Promise<OutreachTemplateRecord | null>;
  create(input: CreateTemplateInput): Promise<OutreachTemplateRecord>;
  /** Update an existing template; null when the id is unknown. */
  update(id: string, input: UpdateTemplateInput): Promise<OutreachTemplateRecord | null>;
}
