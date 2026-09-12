import { createHash } from 'node:crypto';

import { ChallengeError, type ChallengePackFactory, type ChallengeSubject } from '@rhea/challenge';
import type {
  AuthorizeCapabilityInput,
  AuthorizationDecision,
  RevalidateAuthorizationInput,
  AuthorizationRevalidation,
} from '@rhea/quality-control';

interface CapabilityAuthority {
  authorizeCapability(input: AuthorizeCapabilityInput): Promise<AuthorizationDecision>;
  revalidateAuthorization(input: RevalidateAuthorizationInput): Promise<AuthorizationRevalidation>;
}

function ageBand(grade: number) {
  return grade <= 2
    ? ('lower_primary' as const)
    : grade <= 4
      ? ('middle_primary' as const)
      : ('upper_primary' as const);
}

function seed(value: string): number {
  return Number.parseInt(createHash('sha256').update(value).digest('hex').slice(0, 6), 16);
}

function items(
  subject: ChallengeSubject,
  profileId: string,
  target: string,
  grade: number,
  variantOffset: number,
) {
  const variant = (seed(profileId) % 7) + grade + variantOffset * 11;
  if (subject === 'mathematics') {
    return [
      {
        difficulty: 'foundation' as const,
        gradingRule: { expected: String(variant + grade), kind: 'numeric' as const },
        id: `${profileId}-foundation`,
        knowledgePoint: target,
        prompt: `${variant} + ${grade} = ?`,
      },
      {
        difficulty: 'practice' as const,
        gradingRule: { expected: String((variant + 1) * 2), kind: 'numeric' as const },
        id: `${profileId}-practice`,
        knowledgePoint: target,
        prompt: `${variant + 1} × 2 = ?`,
      },
    ];
  }
  const labels: Record<Exclude<ChallengeSubject, 'mathematics'>, [string, string]> = {
    chinese: ['选择最符合题意的一项', '完整、准确地理解句意'],
    english: ['Choose the best answer', 'Read the sentence and choose accurately'],
    science: ['选择符合科学事实的一项', '根据现象判断科学事实'],
  };
  const [prefix, correct] = labels[subject];
  return [
    {
      difficulty: 'foundation' as const,
      gradingRule: { correctOptionId: 'b', kind: 'single_choice' as const },
      id: `${profileId}-foundation`,
      knowledgePoint: target,
      options: [
        { id: 'a', text: `干扰项 ${variant}` },
        { id: 'b', text: correct },
      ],
      prompt: `${prefix}（变式 ${variant}）`,
    },
    {
      difficulty: 'practice' as const,
      gradingRule: { correctOptionId: 'a', kind: 'single_choice' as const },
      id: `${profileId}-practice`,
      knowledgePoint: target,
      options: [
        { id: 'a', text: correct },
        { id: 'b', text: `干扰项 ${variant + 1}` },
      ],
      prompt: `${prefix}（应用 ${variant + 1}）`,
    },
  ];
}

export function createDeterministicChallengePackFactory(
  authority: CapabilityAuthority,
): ChallengePackFactory {
  return {
    async createEquivalentPacks(input) {
      const decision = await authority.authorizeCapability({
        capabilityKey: 'ai.challenge-pack',
        familySpaceId: input.participants[0]!.familySpaceId,
        kind: 'ai',
        slice: {
          basisState: 'current',
          gradeBand: ageBand(input.grade),
          imageQuality: 'not_applicable',
          questionType: 'objective',
          riskLevel: 'low',
          subject: input.subject,
        },
      });
      if (decision.status !== 'authorized' || !decision.primary) {
        throw new ChallengeError('GENERATED_PACK_INVALID', '当前没有已获准的挑战题包能力');
      }
      const revalidated = await authority.revalidateAuthorization({
        decisionId: decision.decisionId,
        expectedContainmentEpoch: decision.containmentEpoch,
        phase: 'before_publish',
        route: 'primary',
      });
      if (revalidated.status !== 'authorized') {
        throw new ChallengeError('GENERATED_PACK_INVALID', '挑战题包能力授权已变化，请稍后重试');
      }
      return {
        authorizationDecisionId: decision.decisionId,
        capabilityVersionId: revalidated.capabilityVersion.id,
        packs: input.participants.map((participant, index) => ({
          items: items(
            input.subject,
            participant.learningProfileId,
            input.target,
            input.grade,
            index,
          ),
          learningProfileId: participant.learningProfileId,
        })),
      };
    },
  };
}
