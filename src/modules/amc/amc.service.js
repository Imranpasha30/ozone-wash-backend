const AmcRepository = require('./amc.repository');

// AMC plan durations in months
const PLAN_DURATIONS = {
  monthly: 1,
  bimonthly: 2,
  quarterly: 3,
  '4month': 4,
  halfyearly: 6,
  yearly: 12,
};

// AMC pricing per plan
const PLAN_PRICES = {
  monthly: 120000,      // ₹1,200 per month
  bimonthly: 220000,    // ₹2,200
  quarterly: 320000,    // ₹3,200
  '4month': 420000,     // ₹4,200
  halfyearly: 600000,   // ₹6,000
  yearly: 1100000,      // ₹11,000
};

const AmcService = {

  // Create a new AMC contract
  createContract: async (customerId, data) => {
    // Validate plan type
    if (!PLAN_DURATIONS[data.plan_type]) {
      throw { status: 400, message: 'Invalid plan type.' };
    }

    // Calculate end date based on plan duration
    const startDate = new Date(data.start_date || Date.now());
    const endDate = new Date(startDate);
    endDate.setMonth(endDate.getMonth() + PLAN_DURATIONS[data.plan_type]);

    // Default SLA terms
    const slaTerms = data.sla_terms || {
      response_hrs: 24,
      cleaning_freq: PLAN_DURATIONS[data.plan_type],
      incident_resolution_hrs: 48,
    };

    const contract = await AmcRepository.create({
      customer_id: customerId,
      tank_ids: data.tank_ids || [],
      plan_type: data.plan_type,
      sla_terms: slaTerms,
      start_date: startDate,
      end_date: endDate,
      amount_paise: PLAN_PRICES[data.plan_type],
    });

    return contract;
  },

  // Get customer contracts
  getMyContracts: async (customerId) => {
    return await AmcRepository.findByCustomer(customerId);
  },

  // Get single contract
  getContract: async (contractId, userId, userRole) => {
    const contract = await AmcRepository.findById(contractId);
    if (!contract) {
      throw { status: 404, message: 'Contract not found.' };
    }

    // Customer can only see their own contracts
    if (userRole === 'customer' && contract.customer_id !== userId) {
      throw { status: 403, message: 'Access denied.' };
    }

    return contract;
  },

  // Get all contracts (admin)
  getAllContracts: async (filters) => {
    return await AmcRepository.findAll(filters);
  },

  // Save e-signatures
  signContract: async (contractId, customerId, customerEsign) => {
    const contract = await AmcRepository.findById(contractId);
    if (!contract) {
      throw { status: 404, message: 'Contract not found.' };
    }

    if (contract.customer_id !== customerId) {
      throw { status: 403, message: 'Access denied.' };
    }

    return await AmcRepository.saveSignatures(
      contractId,
      customerEsign,
      contract.admin_esign
    );
  },

  // Admin signs contract
  adminSignContract: async (contractId, adminEsign) => {
    const contract = await AmcRepository.findById(contractId);
    if (!contract) {
      throw { status: 404, message: 'Contract not found.' };
    }

    return await AmcRepository.saveSignatures(
      contractId,
      contract.customer_esign,
      adminEsign
    );
  },

  // Renew a contract
  renewContract: async (contractId, userId, userRole) => {
    const contract = await AmcRepository.findById(contractId);
    if (!contract) {
      throw { status: 404, message: 'Contract not found.' };
    }

    if (userRole === 'customer' && contract.customer_id !== userId) {
      throw { status: 403, message: 'Access denied.' };
    }

    // Calculate new end date
    const newStartDate = new Date(contract.end_date);
    const newEndDate = new Date(newStartDate);
    newEndDate.setMonth(
      newEndDate.getMonth() + PLAN_DURATIONS[contract.plan_type]
    );

    // Create new contract with same terms
    const renewed = await AmcRepository.create({
      customer_id: contract.customer_id,
      tank_ids: contract.tank_ids,
      plan_type: contract.plan_type,
      sla_terms: contract.sla_terms,
      start_date: newStartDate,
      end_date: newEndDate,
      amount_paise: PLAN_PRICES[contract.plan_type],
    });

    // Mark old contract as expired
    await AmcRepository.updateStatus(contractId, 'expired');

    return renewed;
  },

  // Cancel a contract
  cancelContract: async (contractId, adminId) => {
    const contract = await AmcRepository.findById(contractId);
    if (!contract) {
      throw { status: 404, message: 'Contract not found.' };
    }

    if (contract.status === 'cancelled') {
      throw { status: 400, message: 'Contract already cancelled.' };
    }

    return await AmcRepository.updateStatus(contractId, 'cancelled');
  },

  // Get contracts expiring soon (for renewal alerts)
  getExpiringSoon: async (days = 30) => {
    return await AmcRepository.getExpiringSoon(days);
  },

  // Get SLA breaches
  getSlaBreaches: async () => {
    return await AmcRepository.getSlaBreaches();
  },

  // Get plan pricing info
  getPlanInfo: () => {
    return Object.entries(PLAN_DURATIONS).map(([plan, months]) => ({
      plan_type: plan,
      duration_months: months,
      amount_paise: PLAN_PRICES[plan],
      amount_inr: PLAN_PRICES[plan] / 100,
    }));
  },

};

module.exports = AmcService;