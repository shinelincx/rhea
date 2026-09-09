import type { ConsentKind } from './types.js';

export interface ConsentStatement {
  dataScope: string[];
  kind: ConsentKind;
  purpose: string;
  statementVersion: string;
}

export const CONSENT_CATALOG: readonly ConsentStatement[] = [
  {
    dataScope: ['上传的照片、PDF 页面及完成识别所需的最小裁剪'],
    kind: 'photo_processing',
    purpose: '检查并识别学习资料、练习和作答',
    statementVersion: 'family-consent-v1',
  },
  {
    dataScope: ['已确认的题目、作答及最小必要学习依据'],
    kind: 'ai_processing',
    purpose: '生成适龄讲解、练习、复习卡和小测',
    statementVersion: 'family-consent-v1',
  },
  {
    dataScope: ['年级、系统身份、本场题目和挑战进度'],
    kind: 'peer_challenge',
    purpose: '参加邀请码学习伙伴或全网同年级匿名挑战',
    statementVersion: 'family-consent-v1',
  },
  {
    dataScope: ['设备推送标识和通用提醒状态'],
    kind: 'notifications',
    purpose: '提醒学习安排和需要监护人处理的事项',
    statementVersion: 'family-consent-v1',
  },
] as const;

export function consentStatement(kind: ConsentKind): ConsentStatement {
  const statement = CONSENT_CATALOG.find((candidate) => candidate.kind === kind);
  if (!statement) {
    throw new Error(`Consent statement is missing for ${kind}`);
  }
  return statement;
}
