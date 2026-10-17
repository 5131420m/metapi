/**
 * Throughput (tokens/sec) a channel must sustain to count as "full speed".
 *
 * One number with two consumers that must agree: the router's weighted speed component
 * saturates at it (extra speed stops buying probability), and the routes page colours a
 * channel's speed badge as healthy at or above it. Defined here so the badge cannot drift
 * from what the score actually rewards.
 */
export const ROUTING_SPEED_TARGET_TPS = 30;
