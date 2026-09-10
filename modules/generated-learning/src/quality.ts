import type {
  GeneratedLearningPackCandidate,
  GeneratedQuestionCandidate,
  GenerationSourceSnapshot,
} from './types.js';

export type DeterministicContentVerification = 'failed' | 'unverified' | 'verified';

function escaped(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function containsAnswer(text: string, answerValue: string): boolean {
  const answer = answerValue.trim();
  if (!answer) return false;
  if (/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/.test(answer)) {
    return new RegExp(`(?<![\\d.])${escaped(answer)}(?![\\d.])`).test(text);
  }
  if (/^[a-z]$/i.test(answer)) {
    return new RegExp(`\\b${escaped(answer)}\\b`, 'i').test(text);
  }
  return text.toLocaleLowerCase().includes(answer.toLocaleLowerCase());
}

export function hasPrematureAnswerLeakage(candidate: GeneratedLearningPackCandidate): boolean {
  const sharedVisibleText = [
    candidate.summary.title,
    ...candidate.summary.keyPoints,
    ...candidate.keyTerms.map(({ term }) => term),
    ...candidate.supplementalNotes,
    candidate.orientationHint,
    candidate.methodHint,
  ].join('\n');
  const defaultVisibleText = [
    sharedVisibleText,
    ...candidate.quiz.map(({ question }) => question),
    ...candidate.variations.map(({ question }) => question),
  ].join('\n');
  if (
    containsAnswer(defaultVisibleText, candidate.fullExplanation.answer) ||
    /(?:答案|结果是|所以(?:商|结果))/.test(`${candidate.orientationHint}\n${candidate.methodHint}`)
  ) {
    return true;
  }
  return [...candidate.quiz, ...candidate.variations].some((question) => {
    const hiddenAnswers = [
      question.expectedAnswer,
      ...(question.gradingRule.kind === 'accepted_text'
        ? question.gradingRule.acceptedAnswers
        : question.gradingRule.kind === 'numeric'
          ? [question.gradingRule.expected]
          : [question.gradingRule.correctOption]),
    ];
    return hiddenAnswers.some(
      (answer) =>
        containsAnswer(sharedVisibleText, answer) || containsAnswer(question.question, answer),
    );
  });
}

interface ArithmeticEquation {
  result: string;
  right: string;
  valid: boolean;
}

function arithmeticEquations(text: string): ArithmeticEquation[] {
  const equations = [
    ...text.matchAll(
      /(?<![\d.])(-?(?:\d+(?:\.\d+)?|\.\d+))\s*([+\-×÷*/])\s*(-?(?:\d+(?:\.\d+)?|\.\d+))\s*[=＝]\s*(-?(?:\d+(?:\.\d+)?|\.\d+))(?![\d.])/g,
    ),
  ];
  return equations.map((match) => {
    const left = Number(match[1]);
    const rightOperand = Number(match[3]);
    const operator = match[2];
    const result =
      operator === '+'
        ? left + rightOperand
        : operator === '-'
          ? left - rightOperand
          : operator === '×' || operator === '*'
            ? left * rightOperand
            : rightOperand === 0
              ? Number.NaN
              : left / rightOperand;
    const right = normalizedNumber(match[4]!);
    return {
      result: String(result),
      right: right ?? '',
      valid: Number.isFinite(result) && right !== null && String(result) === right,
    };
  });
}

function arithmeticAnswer(text: string): string | null {
  const matches = [...text.matchAll(/(?<!\d)(-?\d+)\s*([+\-×÷])\s*(-?\d+)(?!\d)/g)];
  if (matches.length !== 1) return null;
  const match = matches[0]!;
  const left = Number(match[1]);
  const right = Number(match[3]);
  const operator = match[2];
  if (!Number.isSafeInteger(left) || !Number.isSafeInteger(right)) return null;
  const expected =
    operator === '+'
      ? left + right
      : operator === '-'
        ? left - right
        : operator === '×'
          ? left * right
          : right === 0
            ? null
            : left / right;
  return expected !== null && Number.isFinite(expected) ? String(expected) : null;
}

function normalizedNumber(value: string): string | null {
  const trimmed = value.trim();
  if (!/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/.test(trimmed)) return null;
  const result = Number(trimmed);
  return Number.isFinite(result) ? String(result) : null;
}

function verifiesArithmetic(question: GeneratedQuestionCandidate): boolean | null {
  const trustedAnswer = arithmeticAnswer(question.question);
  if (trustedAnswer === null) return null;
  const answerIsValid =
    normalizedNumber(question.expectedAnswer) === trustedAnswer &&
    question.gradingRule.kind === 'numeric' &&
    normalizedNumber(question.gradingRule.expected) === trustedAnswer;
  if (!answerIsValid) return false;
  const equations = question.explanationSteps.flatMap(arithmeticEquations);
  if (equations.some(({ valid }) => !valid)) return false;
  return equations.length > 0 ? true : null;
}

export function verifyDeterministicContent(
  candidate: GeneratedLearningPackCandidate,
  source: GenerationSourceSnapshot,
): DeterministicContentVerification {
  if (source.subject !== 'mathematics') return 'unverified';
  const sourceQuestions = source.excerpts.filter(({ kind }) => kind === 'question');
  const trustedSourceAnswers = sourceQuestions
    .map(({ text }) => arithmeticAnswer(text))
    .filter((answer): answer is string => answer !== null);
  if (
    trustedSourceAnswers.length > 0 &&
    !trustedSourceAnswers.some(
      (answer) => normalizedNumber(candidate.fullExplanation.answer) === answer,
    )
  ) {
    return 'failed';
  }
  const fullExplanationEquations = candidate.fullExplanation.steps.flatMap(arithmeticEquations);
  if (fullExplanationEquations.some(({ valid }) => !valid)) return 'failed';
  const generatedResults = [...candidate.quiz, ...candidate.variations].map(verifiesArithmetic);
  if (generatedResults.some((result) => result === false)) return 'failed';
  return trustedSourceAnswers.length === 1 &&
    fullExplanationEquations.some(
      ({ result, right, valid }) =>
        valid && result === trustedSourceAnswers[0] && right === trustedSourceAnswers[0],
    ) &&
    generatedResults.every((result) => result === true)
    ? 'verified'
    : 'unverified';
}
