export type DraftQualityWarning = 'blurry' | 'too_dark' | 'glare' | 'missing_edge';

export interface DraftPage {
  crop: { height: number; width: number; x: number; y: number } | null;
  fileName: string;
  height: number | null;
  id: string;
  mimeType: string;
  qualityWarnings: DraftQualityWarning[];
  rotation: 0 | 90 | 180 | 270;
  sizeBytes: number;
  width: number | null;
}

export interface CaptureDraft {
  createdAt: string;
  id: string;
  learningProfileId: string;
  pages: DraftPage[];
  updatedAt: string;
}

export interface DraftValidation {
  errors: string[];
  valid: boolean;
}

const SUPPORTED_MIME_TYPES = new Set([
  'application/pdf',
  'image/heic',
  'image/heif',
  'image/jpeg',
  'image/png',
  'image/webp',
]);

export const MAX_DRAFT_PAGES = 30;
export const MAX_PAGE_BYTES = 15 * 1024 * 1024;
export const MAX_DRAFT_BYTES = 50 * 1024 * 1024;

export function createCaptureDraft(input: {
  id: string;
  learningProfileId: string;
  now: string;
}): CaptureDraft {
  return {
    createdAt: input.now,
    id: input.id,
    learningProfileId: input.learningProfileId,
    pages: [],
    updatedAt: input.now,
  };
}

export function addDraftPages(draft: CaptureDraft, pages: DraftPage[], now: string): CaptureDraft {
  return { ...draft, pages: [...draft.pages, ...pages], updatedAt: now };
}

export function deleteDraftPage(draft: CaptureDraft, pageId: string, now: string): CaptureDraft {
  return { ...draft, pages: draft.pages.filter((page) => page.id !== pageId), updatedAt: now };
}

export function replaceDraftPage(
  draft: CaptureDraft,
  pageId: string,
  replacement: DraftPage,
  now: string,
): CaptureDraft {
  return {
    ...draft,
    pages: draft.pages.map((page) =>
      page.id === pageId ? { ...replacement, id: pageId, rotation: 0, crop: null } : page,
    ),
    updatedAt: now,
  };
}

export function moveDraftPage(
  draft: CaptureDraft,
  pageId: string,
  direction: -1 | 1,
  now: string,
): CaptureDraft {
  const from = draft.pages.findIndex((page) => page.id === pageId);
  const to = from + direction;
  if (from < 0 || to < 0 || to >= draft.pages.length) {
    return draft;
  }
  const pages = [...draft.pages];
  const [page] = pages.splice(from, 1);
  pages.splice(to, 0, page!);
  return { ...draft, pages, updatedAt: now };
}

export function rotateDraftPage(draft: CaptureDraft, pageId: string, now: string): CaptureDraft {
  return {
    ...draft,
    pages: draft.pages.map((page) =>
      page.id === pageId
        ? { ...page, rotation: ((page.rotation + 90) % 360) as DraftPage['rotation'] }
        : page,
    ),
    updatedAt: now,
  };
}

export function cropDraftPage(draft: CaptureDraft, pageId: string, now: string): CaptureDraft {
  return {
    ...draft,
    pages: draft.pages.map((page) =>
      page.id === pageId
        ? { ...page, crop: { height: 0.92, width: 0.92, x: 0.04, y: 0.04 } }
        : page,
    ),
    updatedAt: now,
  };
}

export function validateDraft(draft: CaptureDraft): DraftValidation {
  const errors: string[] = [];
  if (draft.pages.length === 0) {
    errors.push('请至少添加一页作业。');
  }
  if (draft.pages.length > MAX_DRAFT_PAGES) {
    errors.push(`一份作业最多 ${MAX_DRAFT_PAGES} 页，请删除或拆分后再试。`);
  }
  const unsupported = draft.pages.find((page) => !SUPPORTED_MIME_TYPES.has(page.mimeType));
  if (unsupported) {
    errors.push(`${unsupported.fileName} 的文件类型不支持，请使用图片或 PDF。`);
  }
  const oversized = draft.pages.find((page) => page.sizeBytes > MAX_PAGE_BYTES);
  if (oversized) {
    errors.push(`${oversized.fileName} 超过单页 15 MB，请压缩或重拍。`);
  }
  const totalBytes = draft.pages.reduce((sum, page) => sum + page.sizeBytes, 0);
  if (totalBytes > MAX_DRAFT_BYTES) {
    errors.push('整份作业超过 50 MB，请压缩图片或拆分作业。');
  }
  return { errors, valid: errors.length === 0 };
}
