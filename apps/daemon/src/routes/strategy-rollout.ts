import type { Express, RequestHandler } from 'express';
import type { OdNextRolloutControlResponse } from '@open-design/contracts';

import {
  constrainOdNextPolicyForPromptMode,
  readOdNextRolloutPolicy,
  readOdNextRolloutControlStatus,
  type OdNextRolloutAppConfig,
} from '../strategies/od-next/rollout.js';
import { readPromptMode } from '../prompts/passthrough.js';

/** Read-only engineering status: the active default or an environment override.
 * Legacy saved preferences remain readable for compatibility but no longer
 * control this daemon's rollout. No user Labs switch consumes this status.
 */
export function registerStrategyRolloutRoutes(app: Express, deps: {
  requireLocalDaemonRequest: RequestHandler;
  /**
   * The legacy preference reader is retained without changing the route contract.
   * Current rollout policy ignores its value.
   */
  readOdNextPreference: () => Promise<OdNextRolloutAppConfig>;
}): void {
  app.get(
    '/api/strategies/od-next/rollout',
    deps.requireLocalDaemonRequest,
    async (_req, res) => {
      const preference = await deps.readOdNextPreference();
      const promptMode = readPromptMode(process.env);
      const status = readOdNextRolloutControlStatus(process.env, preference);
      const constrained = constrainOdNextPolicyForPromptMode(
        readOdNextRolloutPolicy(process.env, preference),
        promptMode,
      );
      const body: OdNextRolloutControlResponse = {
        status: {
          ...status,
          requestedMode: constrained.requestedMode,
          effectiveMode: promptMode === 'passthrough' ? 'off' : status.effectiveMode,
        },
      };
      res.json(body);
    },
  );
}
