/**
 * Opaque identity for one retained agent conversation.
 *
 * Pipeline stages may preserve and compare this value, but provider runtime
 * state remains private to the harness adapter that created it.
 */
declare const agentSessionBrand: unique symbol;

export interface AgentSession {
  readonly [agentSessionBrand]: typeof agentSessionBrand;
}
