import { describe, expect, it } from 'vitest';

import {
  LearningContentError,
  LearningContentService,
  MemoryLearningContentStore,
  type ClassificationDraft,
} from '../src/index.js';

const learner = { id: 'profile-1', type: 'learner' as const };

function classified(overrides: Partial<ClassificationDraft> = {}): ClassificationDraft {
  return {
    coursePathName: '沪教版三年级上册',
    knowledgePointNames: ['两位数乘法', '估算'],
    primaryKnowledgePointName: '两位数乘法',
    primarySubject: 'mathematics',
    relatedSubjects: [],
    unitName: '乘法',
    ...overrides,
  };
}

function setup() {
  const service = new LearningContentService({ store: new MemoryLearningContentStore() });
  return { service };
}

describe('learning content organization', () => {
  it('keeps uncertain content pending instead of guessing a subject', async () => {
    const { service } = setup();
    const material = await service.organizeConfirmedContent({
      actor: learner,
      classification: {
        coursePathName: null,
        knowledgePointNames: [],
        primaryKnowledgePointName: null,
        primarySubject: null,
        relatedSubjects: [],
        unitName: null,
      },
      confirmedContentVersion: 1,
      confirmedContentVersionId: 'confirmed-1',
      familySpaceId: 'family-1',
      learningProfileId: 'profile-1',
      sourceHash: 'a'.repeat(64),
    });

    expect(material.currentClassification).toMatchObject({
      primarySubject: null,
      revision: 1,
      status: 'pending',
    });
    expect(material.basis).toMatchObject({
      currentSourceVersionId: material.sourceVersions[0]?.id,
      hasConflict: false,
    });
  });

  it('organizes all four supported subjects and records corrections as new versions', async () => {
    const { service } = setup();
    const subjects = ['chinese', 'mathematics', 'english', 'science'] as const;
    for (const [index, subject] of subjects.entries()) {
      const material = await service.organizeConfirmedContent({
        actor: learner,
        classification: classified({ primarySubject: subject }),
        confirmedContentVersion: 1,
        confirmedContentVersionId: `confirmed-${index}`,
        familySpaceId: 'family-1',
        learningProfileId: 'profile-1',
        sourceHash: `${index + 1}`.repeat(64),
      });
      expect(material.currentClassification.primarySubject).toBe(subject);
    }

    const original = await service.getByConfirmedContent({
      confirmedContentVersionId: 'confirmed-1',
      learningProfileId: 'profile-1',
    });
    const corrected = await service.correctClassification({
      actor: { id: 'guardian-1', type: 'guardian' },
      classification: classified({
        coursePathName: '沪教版三年级上册',
        knowledgePointNames: ['阅读理解'],
        primaryKnowledgePointName: '阅读理解',
        primarySubject: 'chinese',
        unitName: '现代文阅读',
      }),
      materialId: original.id,
      learningProfileId: 'profile-1',
      reason: '监护人依据教材目录修正',
    });

    expect(corrected.classificationHistory).toHaveLength(2);
    expect(corrected.classificationHistory[0]).toMatchObject({
      changedBy: learner,
      revision: 1,
      source: 'initial',
    });
    expect(corrected.currentClassification).toMatchObject({
      changedBy: { id: 'guardian-1', type: 'guardian' },
      primarySubject: 'chinese',
      revision: 2,
      source: 'correction',
    });
  });

  it('marks conflicting immutable sources while retaining an explicit current basis', async () => {
    const { service } = setup();
    const material = await service.organizeConfirmedContent({
      actor: learner,
      classification: classified(),
      confirmedContentVersion: 1,
      confirmedContentVersionId: 'confirmed-1',
      familySpaceId: 'family-1',
      learningProfileId: 'profile-1',
      sourceHash: 'a'.repeat(64),
    });
    const firstAnswer = await service.addSourceVersion({
      actor: learner,
      contentHash: 'b'.repeat(64),
      kind: 'answer',
      label: '教师答案',
      learningProfileId: 'profile-1',
      materialId: material.id,
      versionLabel: '2026-09-09',
    });

    expect(firstAnswer.basis).toMatchObject({
      currentSourceVersionId: material.sourceVersions[0]?.id,
      hasConflict: false,
    });
    const teacherAnswer = await service.addSourceVersion({
      actor: learner,
      contentHash: 'c'.repeat(64),
      kind: 'answer',
      label: '教师修订答案',
      learningProfileId: 'profile-1',
      materialId: material.id,
      versionLabel: '2026-09-10',
    });
    expect(teacherAnswer.basis.hasConflict).toBe(true);
    expect(teacherAnswer.sourceVersions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ contentHash: 'b'.repeat(64), kind: 'answer', versionNumber: 1 }),
        expect.objectContaining({ contentHash: 'c'.repeat(64), kind: 'answer', versionNumber: 2 }),
      ]),
    );

    const selected = await service.selectCurrentBasis({
      actor: learner,
      learningProfileId: 'profile-1',
      materialId: material.id,
      reason: '采用教师答案',
      sourceVersionId: teacherAnswer.sourceVersions.at(-1)!.id,
    });
    expect(selected.basis).toMatchObject({
      currentSourceVersionId: teacherAnswer.sourceVersions.at(-1)!.id,
      hasConflict: true,
      selectionRevision: 2,
    });
    await expect(
      service.getCurrentBasisReference({
        learningProfileId: 'profile-1',
        materialId: material.id,
      }),
    ).resolves.toMatchObject({
      contentHash: 'c'.repeat(64),
      materialId: material.id,
      selectionVersion: 2,
      sourceVersionId: teacherAnswer.sourceVersions.at(-1)!.id,
    });
    await service.invalidateByConfirmedContent({
      actor: learner,
      confirmedContentVersionId: 'confirmed-1',
      learningProfileId: 'profile-1',
      reason: '确认内容已被新版本取代',
    });
    await expect(
      service.getCurrentBasisReference({
        learningProfileId: 'profile-1',
        materialId: material.id,
      }),
    ).rejects.toMatchObject({ code: 'UPSTREAM_INVALIDATED' });
  });

  it('rejects taxonomy details when content is pending classification', async () => {
    const { service } = setup();
    await expect(
      service.organizeConfirmedContent({
        actor: learner,
        classification: classified({ primarySubject: null }),
        confirmedContentVersion: 1,
        confirmedContentVersionId: 'confirmed-invalid',
        familySpaceId: 'family-1',
        learningProfileId: 'profile-1',
        sourceHash: 'a'.repeat(64),
      }),
    ).rejects.toEqual(expect.any(LearningContentError));

    await expect(
      service.organizeConfirmedContent({
        actor: learner,
        classification: {
          coursePathName: null,
          knowledgePointNames: [],
          primaryKnowledgePointName: null,
          primarySubject: null,
          relatedSubjects: ['science'],
          unitName: null,
        },
        confirmedContentVersion: 1,
        confirmedContentVersionId: 'confirmed-related-subject',
        familySpaceId: 'family-1',
        learningProfileId: 'profile-1',
        sourceHash: 'a'.repeat(64),
      }),
    ).rejects.toEqual(expect.any(LearningContentError));
  });
});
