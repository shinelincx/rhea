import { fireEvent, render } from '@testing-library/react-native';

import { PrototypeDemoContent } from '../src/prototype-demo/PrototypeDemoApp';
import { createPrototypeDemoRuntime } from '../src/prototype-demo/runtime';
import type { CaptureDraft } from '../src/capture-draft/model';

const scope = {
  accessToken: 'demo-access-token',
  familySpaceId: 'demo-family',
  learningProfileId: 'demo-profile',
};

describe('prototype demo runtime', () => {
  it('runs the photo grading, wrong-item review, and random challenge loop without a backend', async () => {
    const runtime = createPrototypeDemoRuntime();
    const route = await runtime.loadTodayRoute();
    expect(route.items.map((item) => item.action)).toEqual([
      'confirm_content',
      'start_review',
      'start_challenge',
    ]);

    const draft: CaptureDraft = {
      createdAt: '2026-09-14T00:00:00.000Z',
      id: 'demo-draft',
      learningProfileId: scope.learningProfileId,
      pages: [
        {
          crop: null,
          fileName: 'math-homework.jpg',
          height: 1200,
          id: 'demo-page',
          mimeType: 'image/jpeg',
          qualityWarnings: [],
          rotation: 0,
          sizeBytes: 3,
          width: 900,
        },
      ],
      updatedAt: '2026-09-14T00:00:00.000Z',
    };
    const recognized = await runtime.submissionGateway.submit({
      accessToken: scope.accessToken,
      draft,
      pageContents: new Map([['demo-page', new Uint8Array([1, 2, 3])]]),
    });
    expect(recognized.status).toBe('awaiting_confirmation');
    expect(recognized.candidate?.regions.map((region) => region.text)).toEqual(['48 ÷ 6 = ?', '6']);

    const confirmed = await runtime.submissionGateway.confirm(scope.accessToken, recognized.id, {});
    expect(confirmed.status).toBe('completed');
    const material = await runtime.submissionGateway.organize({
      ...scope,
      classification: {
        coursePathName: '沪教版四年级',
        knowledgePointNames: ['除法验算'],
        primaryKnowledgePointName: '除法验算',
        primarySubject: 'mathematics',
        relatedSubjects: [],
        unitName: '整数除法',
      },
      processingJobId: confirmed.id,
    });
    expect(material.currentClassification.status).toBe('classified');

    const assessment = await runtime.submissionGateway.gradeObjective({
      ...scope,
      inputReference: {
        confirmedContentVersionId: confirmed.completedContent!.id,
        processingJobId: confirmed.id,
        questionRegionId: 'demo-question',
        responseRegionId: 'demo-answer',
      },
      materialId: material.id,
    });
    expect(assessment.currentVersion.decision.outcome).toBe('incorrect');

    const review = await runtime.reviewCardGateway.createSession(scope);
    expect(review.cards[0]).toMatchObject({
      aiGenerated: true,
      content: { question: '把 56 个贴纸平均分给 7 位同学，每人能分到多少个？' },
      original: { question: '48 ÷ 6 = ?', response: '6' },
    });

    const match = await runtime.challengeGateway.enterRandomMatch({
      ...scope,
      subject: 'mathematics',
    });
    expect(match.status).toBe('matched');
    if (match.status === 'matched') {
      const completedChallenge = await runtime.challengeGateway.submitAnswer({
        ...scope,
        answer: '8',
        challengeId: match.challenge.id,
        commandId: 'demo-command',
        itemId: match.challenge.items[0]!.id,
      });
      expect(completedChallenge).toMatchObject({
        noPenalty: true,
        speedAffectsScore: false,
        status: 'completed',
      });
    }
  });

  it('opens the runnable prototype on Today and navigates to AI review', async () => {
    const view = await render(<PrototypeDemoContent />);
    expect(await view.findByText('原型体验版 · 数据保存在本次运行中')).toBeVisible();
    expect(view.getByText('今天先做什么？')).toBeVisible();
    await fireEvent.press(view.getByRole('button', { name: '开始：用 AI 复习一个错题' }));
    expect(
      await view.findByText('把 56 个贴纸平均分给 7 位同学，每人能分到多少个？'),
    ).toBeVisible();
  });
});
