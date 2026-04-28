/**
 * Rewards service — Phase A redemption business logic.
 *
 * Eligibility rules (PDF "Ecoscore Dashboard - Revised & Updated", page 5):
 *   • non-streak rewards: user can afford if wallet.eco_points >= cost_points
 *   • streak rewards   : user qualifies if eco_scores.badge >= requires_streak
 *                        (and the streak-tier rewards have cost_points = 0,
 *                        so the wallet balance does not gate them)
 *
 * The service layer keeps controllers thin and is the only place that calls
 * the repository. All point-mutating flows funnel through redeem().
 */

const RewardsRepository = require('./rewards.repository');

// Streak tier ranking — used to compare a user's current badge against the
// reward's requires_streak gate. A user with a HIGHER badge automatically
// qualifies for LOWER streak-gated rewards (e.g. Platinum users qualify for
// both 'platinum' and 'gold' streak rewards).
const BADGE_RANK = { unrated: 0, bronze: 1, silver: 2, gold: 3, platinum: 4 };

function meetsStreakRequirement(userBadge, requiredBadge) {
  if (!requiredBadge) return true;
  const userR = BADGE_RANK[userBadge] || 0;
  const reqR = BADGE_RANK[requiredBadge] || 0;
  return userR >= reqR;
}

const RewardsService = {

  /** Public catalog — every active reward, no eligibility flags. */
  getCatalog: async () => {
    const rewards = await RewardsRepository.listActive();
    return rewards.map((r) => ({
      slug: r.slug,
      name: r.name,
      description: r.description,
      cost_points: r.cost_points,
      category: r.category,
      requires_streak: r.requires_streak || null,
    }));
  },

  /**
   * Authenticated /me endpoint — returns wallet + every reward annotated
   * with an `eligible` boolean and a `reason` string when not eligible.
   */
  getMyRewards: async (userId) => {
    const [{ wallet, eco }, rewards] = await Promise.all([
      RewardsRepository.getWalletAndBadge(userId),
      RewardsRepository.listActive(),
    ]);

    const annotated = rewards.map((r) => {
      const streakOk = meetsStreakRequirement(eco.badge, r.requires_streak);
      const cost = Number(r.cost_points) || 0;
      const canAfford = wallet.eco_points >= cost;

      // Streak-gated rewards are gated on streak only (cost is 0).
      // Point-priced rewards are gated on affordability only.
      let eligible;
      let reason = null;
      if (r.requires_streak) {
        eligible = streakOk;
        if (!eligible) reason = `Requires ${r.requires_streak} badge tier`;
      } else {
        eligible = canAfford;
        if (!eligible) reason = `Need ${cost - wallet.eco_points} more EcoPoints`;
      }

      return {
        slug: r.slug,
        name: r.name,
        description: r.description,
        cost_points: cost,
        category: r.category,
        requires_streak: r.requires_streak || null,
        eligible,
        reason,
      };
    });

    const history = await RewardsRepository.listForUser(userId, 20);

    return {
      wallet: {
        eco_points: wallet.eco_points,
        lifetime_earned: wallet.lifetime_earned,
        lifetime_redeemed: wallet.lifetime_redeemed,
        cap: wallet.eco_points_capped_at,
      },
      eco: {
        score: eco.score,
        badge: eco.badge,
        streak_days: eco.streak_days,
      },
      rewards: annotated,
      history,
    };
  },

  /**
   * Redeem a reward by slug. Validates eligibility, then delegates to the
   * repository which atomically debits the wallet + creates the redemption.
   */
  redeem: async ({ userId, reward_slug }) => {
    if (!reward_slug || typeof reward_slug !== 'string') {
      throw { status: 400, message: 'reward_slug is required.' };
    }

    const reward = await RewardsRepository.findBySlug(reward_slug);
    if (!reward) throw { status: 404, message: 'Reward not found.' };
    if (!reward.active) {
      throw { status: 400, message: 'Reward is not currently available.' };
    }

    // Streak-gated rewards: verify the user's current badge tier qualifies.
    if (reward.requires_streak) {
      const { eco } = await RewardsRepository.getWalletAndBadge(userId);
      if (!meetsStreakRequirement(eco.badge, reward.requires_streak)) {
        throw {
          status: 400,
          message: `This reward requires the ${reward.requires_streak} badge tier.`,
        };
      }
    }

    const result = await RewardsRepository.redeem({ userId, reward });
    return {
      redemption: result.redemption,
      wallet: result.wallet,
      reward: {
        slug: reward.slug,
        name: reward.name,
        category: reward.category,
        cost_points: reward.cost_points,
      },
    };
  },
};

module.exports = RewardsService;
