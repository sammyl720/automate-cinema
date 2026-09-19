import { z } from 'zod';
import type {
  DecisionEvaluation,
  ScoreJudgment,
  NoulJudgment,
} from '../shared/domain';
import { config } from './config';
import { DomainError, scoreConcept } from './policy';
export const levels = [
  'Weak',
  'Below average',
  'Average',
  'Strong',
  'Exceptional',
] as const;
export const conceptCriteria = [
  'hook',
  'emotion',
  'novelty',
  'clarity',
  'feasibility',
  'retention',
] as const;
export function normalizeJevScore(value: number) {
  if (!Number.isFinite(value) || value < 0 || value > 4)
    throw new DomainError('Invalid Jev ordinal score');
  return Math.round((value / 4) * 100);
}
const probability = z.number().min(0).max(1);
const scoreSchema = z.object({
  type: z.literal('score'),
  score: z.number().min(0).max(4),
  confidence: probability,
  probabilities: z.record(z.string(), probability),
  legend: z.record(z.string(), z.unknown()),
});
export function parseScore(value: unknown): ScoreJudgment {
  const a = scoreSchema.parse(value);
  const keys = ['0', '1', '2', '3', '4'];
  if (
    Object.keys(a.probabilities).length !== 5 ||
    keys.some((k) => a.probabilities[k] === undefined) ||
    Math.abs(
      Object.values(a.probabilities).reduce((sum, p) => sum + p, 0) - 1,
    ) > 0.01 ||
    Math.abs(
      keys.reduce((sum, k) => sum + Number(k) * a.probabilities[k], 0) -
        a.score,
    ) > 0.03
  )
    throw new DomainError(
      'Jev returned an inconsistent score distribution. Review the recorded response.',
    );
  return a;
}
export function parseNoul(value: unknown): NoulJudgment {
  return z.object({ type: z.literal('noul'), noul: probability }).parse(value);
}
export function decisionThresholds() {
  return {
    minimumConceptScore: 80,
    confidence: config.JEV_MIN_CONFIDENCE,
    strongProbability: config.JEV_MIN_STRONG_PROBABILITY,
    preflightScore: config.JEV_PREFLIGHT_MIN_SCORE,
    continuity: config.JEV_CONTINUITY_MIN_PROBABILITY,
    ambiguity: config.JEV_AMBIGUITY_MAX_PROBABILITY,
  };
}
export function judgeDecision(
  stage: DecisionEvaluation['stage'],
  answers: DecisionEvaluation['answers'],
) {
  const thresholds = decisionThresholds();
  const normalizedScores: Record<string, number> = {};
  const reasons: string[] = [];
  const confidences: number[] = [];
  for (const [key, a] of Object.entries(answers)) {
    if (a.type === 'score') {
      normalizedScores[key] = normalizeJevScore(a.score);
      confidences.push(a.confidence);
      if (a.confidence < thresholds.confidence)
        reasons.push(`${key}: confidence below ${thresholds.confidence}`);
      if (
        stage === 'creative_preflight' &&
        normalizedScores[key] < thresholds.preflightScore
      )
        reasons.push(`${key}: score below ${thresholds.preflightScore}`);
    }
  }
  if (stage === 'concept') {
    if (scoreConcept(normalizedScores) < 80)
      reasons.push('Weighted concept score below 80');
    for (const key of ['hook', 'retention']) {
      const a = answers[key] as ScoreJudgment;
      if (
        a.probabilities['3'] + a.probabilities['4'] <
        thresholds.strongProbability
      )
        reasons.push(
          `${key}: P(Strong or Exceptional) below ${thresholds.strongProbability}`,
        );
    }
  } else {
    const continuity = (answers.continuity as NoulJudgment).noul;
    const ambiguity = (answers.ambiguity as NoulJudgment).noul;
    if (continuity < thresholds.continuity)
      reasons.push(`continuity: probability below ${thresholds.continuity}`);
    if (ambiguity > thresholds.ambiguity)
      reasons.push(`ambiguity: probability above ${thresholds.ambiguity}`);
    for (const key of ['unsupportedClaim', 'exaggeration']) {
      const a = answers[key];
      if (a?.type === 'noul' && a.noul > thresholds.ambiguity)
        reasons.push(`${key}: evidence consistency requires human review`);
    }
  }
  return {
    normalizedScores,
    confidence: Math.min(...confidences),
    passed: reasons.length === 0,
    reasons,
    thresholds,
  };
}
