import type { ApprovedOpportunity, TradeSignal } from '../events/event-types.js'

export interface BaseStrategy {
  readonly name: string
  /**
   * Decide whether to act on an approved opportunity.
   * Returns a TradeSignal if the strategy wants to enter, null otherwise.
   */
  decide(opp: ApprovedOpportunity): Promise<TradeSignal | null>
}
