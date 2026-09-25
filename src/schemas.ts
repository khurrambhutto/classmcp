import { z } from "zod";

// --- Shared input fragments -----------------------------------------------
// Every targeting tool accepts an id OR a fuzzy human ref, resolved server-side.

export const CourseRefShape = {
  courseId: z.string().optional().describe("Course id (from get_overview view=courses). Mutually exclusive with course."),
  course: z.string().optional().describe("Course name or fragment, e.g. \"Physics 101\". Fuzzy-matched; use courseId when ambiguous."),
};

export const AssignmentRefShape = {
  assignmentId: z.string().optional().describe("Coursework id (from get_overview/get_assignment). Mutually exclusive with assignment."),
  assignment: z.string().optional().describe("Assignment title or fragment. Fuzzy-matched within the course; use assignmentId when ambiguous."),
};

export const DetailShape = z
  .enum(["concise", "detailed"])
  .default("concise")
  .describe("concise drops links/workType (ids always kept for chaining); detailed adds them.");

// --- Output shapes ---------------------------------------------------------
// Strict zod objects: unknown keys are stripped, so raw Google payloads can
// never leak into results.

export const AttachmentSchema = z.object({
  kind: z.enum(["driveFile", "form", "link", "youtube"]),
  id: z.string().nullable().describe("Drive file id (driveFile only) — pass to download_files."),
  name: z.string().nullable(),
  url: z.string().nullable(),
});

export const WorkRowSchema = z.object({
  course: z.string(),
  courseId: z.string(),
  id: z.string(),
  title: z.string(),
  due: z.string().describe("YYYY-MM-DD or \"none\"."),
  daysLeft: z.number().nullable().describe("Negative = past due. null when there is no due date."),
  myState: z.string().describe("NEW | CREATED | TURNED_IN | RETURNED | RECLAIMED_BY_STUDENT."),
  late: z.boolean(),
  points: z.number().nullable().describe("maxPoints of the assignment."),
  grade: z.number().nullable().describe("assignedGrade, null if ungraded."),
  link: z.string().optional().describe("Classroom web link (detailed only)."),
  workType: z.string().optional().describe("ASSIGNMENT | SHORT_ANSWER_QUESTION | MULTIPLE_CHOICE_QUESTION (detailed only)."),
});

export const NewRowSchema = z.object({
  type: z.enum(["assignment", "material", "announcement"]),
  course: z.string(),
  courseId: z.string(),
  id: z.string(),
  title: z.string(),
  updated: z.string().nullable().describe("ISO timestamp."),
});

export const CourseRowSchema = z.object({
  id: z.string(),
  name: z.string(),
  section: z.string().nullable(),
  state: z.string().nullable().describe("ACTIVE | ARCHIVED | PROVISIONED | DECLINED."),
});

export const OverviewItemSchema = z.union([WorkRowSchema, NewRowSchema, CourseRowSchema]);

export const PartialErrorSchema = z.object({
  courseId: z.string().nullable(),
  course: z.string().nullable(),
  message: z.string(),
});

export const OverviewResultSchema = z.object({
  view: z.enum(["due", "missing", "new", "grades", "courses"]),
  window: z.number(),
  checkedCourses: z.number(),
  total: z.number().describe("Matches after query filtering, before limit."),
  returned: z.number(),
  truncated: z.boolean(),
  hint: z.string().nullable().describe("How to narrow or where to look next; null when there is nothing to add."),
  errors: z.array(PartialErrorSchema).describe("Per-course failures; the rest of the result is still valid."),
  items: z.array(OverviewItemSchema),
});

export const RubricCriterionSchema = z.object({
  criterion: z.string(),
  points: z.number().nullable().describe("Max points for this criterion."),
  levels: z.array(z.object({ label: z.string(), points: z.number().nullable() })),
});

export const HistoryEntrySchema = z.object({
  state: z.string(),
  at: z.string().nullable(),
});

export const AssignmentDetailSchema = z.object({
  courseId: z.string(),
  course: z.string(),
  id: z.string(),
  title: z.string(),
  workType: z.string().nullable(),
  prompt: z.string().describe("Description, whitespace-collapsed and truncated to maxDescChars."),
  due: z.string().nullable(),
  daysLeft: z.number().nullable(),
  points: z.number().nullable(),
  myState: z.string(),
  late: z.boolean(),
  grade: z.number().nullable(),
  link: z.string().nullable(),
  topic: z.string().nullable(),
  rubric: z.array(RubricCriterionSchema).nullable().describe("Null when no rubric is attached or the API denies it."),
  attachments: z.array(AttachmentSchema).describe("Teacher attachments/handouts; driveFile ids work with download_files."),
  myAttachments: z.array(AttachmentSchema).describe("Files/links currently on the student's submission."),
  history: z.array(HistoryEntrySchema).nullable().describe("Latest submission state transitions, oldest first (max 5)."),
});

export const SearchHitSchema = z.object({
  kind: z.enum(["assignment", "material", "announcement"]),
  course: z.string(),
  courseId: z.string(),
  id: z.string(),
  title: z.string(),
  due: z.string().nullable(),
  daysLeft: z.number().nullable(),
  myState: z.string().nullable(),
  snippet: z.string().nullable().describe("Match context from description/body, trimmed."),
  updated: z.string().nullable(),
  link: z.string().optional(),
});

export const SearchResultSchema = z.object({
  query: z.string(),
  checkedCourses: z.number(),
  total: z.number(),
  returned: z.number(),
  truncated: z.boolean(),
  hint: z.string().nullable(),
  errors: z.array(PartialErrorSchema),
  hits: z.array(SearchHitSchema),
});

export const SavedFileSchema = z.object({
  name: z.string(),
  kind: z.enum(["driveFile", "form", "link", "youtube"]),
  path: z.string().nullable().describe("Local path when saved to disk, else null."),
  url: z.string().nullable().describe("Classroom/Drive URL for items that cannot be downloaded."),
  size: z.number().nullable(),
  exportedAs: z.string().nullable().describe("Set when a Google-native file was converted, e.g. \"pdf\"."),
  error: z.string().nullable().describe("Per-file failure reason; null on success."),
});

export const DownloadResultSchema = z.object({
  saved: z.array(SavedFileSchema),
  savedCount: z.number(),
  failedCount: z.number(),
});

export const UploadedFileSchema = z.object({
  name: z.string(),
  id: z.string().nullable().describe("Drive file id."),
  webViewLink: z.string().nullable(),
  size: z.number().nullable(),
  error: z.string().nullable(),
});

// submit_work is best-effort: Google only lets the app that created an
// assignment modify submissions, so attach/turn-in usually return blocked=true
// and the result carries UI links instead. That is a success, not an error.
export const SubmitResultSchema = z.object({
  courseId: z.string(),
  assignmentId: z.string(),
  title: z.string(),
  assignmentLink: z.string().nullable().describe("Open in Classroom to attach/turn in."),
  uploaded: z.array(UploadedFileSchema).describe("Files placed in Drive (this part always works)."),
  attached: z.boolean().describe("True only if Google accepted the attachment."),
  turnedIn: z.boolean(),
  myState: z.string(),
  blocked: z.boolean().describe("True when Google's project restriction rejected attach/turn-in."),
  message: z.string().describe("What happened and the exact next step for the student."),
});

// --- Input schemas (raw shapes for registerTool) ---------------------------

export const OverviewInputShape = {
  view: z.enum(["due", "missing", "new", "grades", "courses"])
    .default("due")
    .describe("due=upcoming open work due within window (overdue/late work lives in missing); missing=overdue/late only, most recently due first; new=recent updates; grades=graded work with scores; courses=course id index."),
  window: z.number().min(1).max(30).default(7).describe("Days: due horizon and new-since. 1-30, default 7."),
  limit: z.number().min(1).max(50).default(20).describe("Max rows returned. 1-50, default 20."),
  query: z.string().max(120).optional().describe("Case-insensitive filter on title/course name."),
  detail: DetailShape,
};

export const AssignmentInputShape = {
  ...CourseRefShape,
  ...AssignmentRefShape,
  maxDescChars: z.number().min(0).max(2000).default(400).describe("Prompt truncation. 0-2000, default 400."),
};

export const SearchInputShape = {
  query: z.string().min(1).max(120).describe("Keywords matched against titles, descriptions, and announcement text."),
  ...CourseRefShape,
  kinds: z.array(z.enum(["assignment", "material", "announcement"])).max(3).optional()
    .describe("Restrict kinds; default all three."),
  limit: z.number().min(1).max(30).default(10).describe("Max hits. 1-30, default 10."),
  detail: DetailShape,
};

export const DownloadInputShape = {
  ...CourseRefShape,
  ...AssignmentRefShape,
  fileIds: z.array(z.string()).max(20).optional().describe("Download only these Drive files instead of every attachment. Max 20."),
  destinationDir: z.string().optional().describe("Must resolve inside ~/Downloads or $CLASSMCP_WORKDIR. Default: <root>/classmcp."),
  exportAs: z.enum(["pdf", "docx", "xlsx", "pptx"]).optional().describe("Format for Google Docs/Slides/Sheets. Defaults: docx/xlsx/pptx."),
};

export const SubmitInputShape = {
  ...CourseRefShape,
  ...AssignmentRefShape,
  files: z.array(z.object({ path: z.string(), name: z.string().optional() })).max(10).optional()
    .describe("Local files to upload to Drive (max 10, 100 MB each). Paths must stay inside ~/Downloads or $CLASSMCP_WORKDIR."),
  fileIds: z.array(z.string()).max(10).optional().describe("Existing Drive file ids to try to attach. Max 10."),
  link: z.object({ url: z.string(), title: z.string().optional() }).optional().describe("A URL attachment to try to attach."),
  turnIn: z.boolean().default(false).describe("false (default) = attach only; true = also attempt turn-in (needs confirmTurnIn)."),
  confirmTurnIn: z.literal("I confirm turn in").optional().describe("Required exactly when turnIn is true."),
};

// --- Infered result types (for helpers/tests) ------------------------------

export type Attachment = z.infer<typeof AttachmentSchema>;
export type WorkRow = z.infer<typeof WorkRowSchema>;
export type NewRow = z.infer<typeof NewRowSchema>;
export type CourseRow = z.infer<typeof CourseRowSchema>;
export type PartialError = z.infer<typeof PartialErrorSchema>;
export type OverviewResult = z.infer<typeof OverviewResultSchema>;
export type AssignmentDetail = z.infer<typeof AssignmentDetailSchema>;
export type RubricCriterion = z.infer<typeof RubricCriterionSchema>;
export type SearchHit = z.infer<typeof SearchHitSchema>;
export type SearchResult = z.infer<typeof SearchResultSchema>;
export type SavedFile = z.infer<typeof SavedFileSchema>;
export type DownloadResult = z.infer<typeof DownloadResultSchema>;
export type UploadedFile = z.infer<typeof UploadedFileSchema>;
export type SubmitResult = z.infer<typeof SubmitResultSchema>;
