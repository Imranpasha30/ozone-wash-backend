const EcoScoreRepository = require('./ecoscore.repository');
const ComplianceRepository = require('../compliance/compliance.repository');
const JobRepository = require('../jobs/job.repository');

const EcoScoreService = {

  // Calculate badge level from score
  getBadgeLevel: (score) => {
    if (score >= 86) return 'platinum';
    if (score >= 66) return 'gold';
    if (score >= 41) return 'silver';
    return 'bronze';
  },

  // Main calculation engine
  calculateScore: async (jobId) => {
    // Get job details
    const job = await JobRepository.findById(jobId);
    if (!job) {
      throw { status: 404, message: 'Job not found.' };
    }

    // Get all compliance steps
    const steps = await ComplianceRepository.getSteps(jobId);
    if (steps.length < 8) {
      throw { status: 400, message: 'Cannot calculate EcoScore — not all 8 steps complete.' };
    }

    // Get data from compliance steps
    const step2 = steps.find(s => s.step_number === 2); // PPE Check
    const step5 = steps.find(s => s.step_number === 5); // Ozone Treatment
    const step3 = steps.find(s => s.step_number === 3); // Tank Drainage

    const scoreBreakdown = {};

    // ── 1. Water Usage Score (25 pts) ────────────────────────────────────
    // Benchmark = tank_size_litres * 0.3
    // If used <= benchmark → 25pts
    // Each 10% over benchmark = -5pts
    const tankSizeLitres = parseFloat(job.tank_size_litres) || 500;
    const waterUsed = parseFloat(step5?.chemical_qty_ml) || 0;
    const waterBenchmark = tankSizeLitres * 0.3;

    let waterScore = 25;
    if (waterUsed > waterBenchmark) {
      const overPercent = ((waterUsed - waterBenchmark) / waterBenchmark) * 100;
      waterScore = Math.max(0, 25 - Math.floor(overPercent / 10) * 5);
    }
    scoreBreakdown.water_score = waterScore;

    // ── 2. Chemical Usage Score (20 pts) ─────────────────────────────────
    // Minimal effective use = 20pts
    // Overuse = proportional deduction
    const chemicalQty = parseFloat(step5?.chemical_qty_ml) || 0;
    const chemicalBenchmark = 500; // 500ml is optimal
    let chemicalScore = 20;
    if (chemicalQty > chemicalBenchmark) {
      const overUse = ((chemicalQty - chemicalBenchmark) / chemicalBenchmark);
      chemicalScore = Math.max(0, Math.round(20 * (1 - overUse)));
    }
    scoreBreakdown.chemical_score = chemicalScore;

    // ── 3. PPE Compliance Score (25 pts) ──────────────────────────────────
    // All 4 items = 25pts, each missing = -6pts
    const requiredPPE = ['mask', 'gloves', 'boots', 'suit'];
    const loggedPPE = step2?.ppe_list || [];
    const ppeArray = Array.isArray(loggedPPE)
      ? loggedPPE
      : JSON.parse(loggedPPE || '[]');
    const missingPPE = requiredPPE.filter(item => !ppeArray.includes(item));
    const ppeScore = Math.max(0, 25 - (missingPPE.length * 6));
    scoreBreakdown.ppe_score = ppeScore;

    // ── 4. On-Time Completion Score (15 pts) ──────────────────────────────
    // Within scheduled window = 15pts
    // Each 30min late = -5pts
    let timeScore = 15;
    if (job.completed_at && job.scheduled_at) {
      const scheduledEnd = new Date(job.scheduled_at);
      scheduledEnd.setHours(scheduledEnd.getHours() + 3); // 3 hour window
      const completedAt = new Date(job.completed_at);
      if (completedAt > scheduledEnd) {
        const lateMinutes = (completedAt - scheduledEnd) / (1000 * 60);
        timeScore = Math.max(0, 15 - Math.floor(lateMinutes / 30) * 5);
      }
    }
    scoreBreakdown.time_score = timeScore;

    // ── 5. Residual Water Management Score (15 pts) ───────────────────────
    // Proper drainage before clean = 15pts
    // Check if tank drainage step has both before and after photos
    const residualScore = (step3?.photo_before_url && step3?.photo_after_url) ? 15 : 7;
    scoreBreakdown.residual_score = residualScore;

    // ── Final Score ───────────────────────────────────────────────────────
    const totalScore = Math.min(100, Math.max(0,
      waterScore + chemicalScore + ppeScore + timeScore + residualScore
    ));
    const badgeLevel = EcoScoreService.getBadgeLevel(totalScore);

    // Save to database
    const saved = await EcoScoreRepository.save({
      job_id: jobId,
      residual_water_before: 0,
      water_used_litres: waterUsed,
      chemical_type: step5?.chemical_type || 'ozone',
      chemical_qty_ml: chemicalQty,
      ppe_list: ppeArray,
      eco_score: totalScore,
      badge_level: badgeLevel,
      score_breakdown: scoreBreakdown,
    });

    return {
      job_id: jobId,
      eco_score: totalScore,
      badge_level: badgeLevel,
      score_breakdown: scoreBreakdown,
      details: {
        water: `${waterScore}/25`,
        chemical: `${chemicalScore}/20`,
        ppe: `${ppeScore}/25`,
        timeliness: `${timeScore}/15`,
        residual: `${residualScore}/15`,
      },
    };
  },

  // Get eco score for a job
  getScore: async (jobId) => {
    const score = await EcoScoreRepository.findByJob(jobId);
    if (!score) {
      throw { status: 404, message: 'EcoScore not calculated yet for this job.' };
    }
    return score;
  },

  // Get team leaderboard
  getLeaderboard: async () => {
    return await EcoScoreRepository.getTeamLeaderboard();
  },

  // Get monthly trends
  getTrends: async () => {
    return await EcoScoreRepository.getTrends();
  },

};

module.exports = EcoScoreService;