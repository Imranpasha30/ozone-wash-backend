const BookingRepository = require('./booking.repository');
const JobRepository = require('../jobs/job.repository');
const AmcRepository = require('../amc/amc.repository');
const EcoScoreRepository = require('../ecoscore/ecoscore.repository');

// Pricing config — one-time service targets ~₹1500+
const BASE_PRICES = {
  overhead: 1200,
  underground: 1800,
  sump: 1500,
};

const ADDON_PRICES = {
  lime_treatment: 500,
  structure_health_check: 800,
  advanced_testing: 1200,
};

// AMC customers get FREE base cleaning (already paid via plan).
// They only pay for optional addons + GST on addons.

const BookingService = {

  // Calculate price for a single tank
  _tankBasePrice: (tank_type, tank_size_litres) => {
    let base = BASE_PRICES[tank_type] || 1000;
    if (tank_size_litres > 1000) {
      base += Math.floor((tank_size_litres - 1000) / 500) * 300;
    }
    return base;
  },

  // Calculate price — supports single tank (backward compat) or multi-tank array
  calculatePrice: (tank_type, tank_size_litres, addons = [], amc_plan = null, tanks = null) => {
    // Multi-tank: sum base price across all tanks
    let basePrice;
    if (tanks && Array.isArray(tanks) && tanks.length > 0) {
      basePrice = tanks.reduce((sum, t) => sum + BookingService._tankBasePrice(t.tank_type, t.tank_size_litres), 0);
    } else {
      basePrice = BookingService._tankBasePrice(tank_type, tank_size_litres);
    }

    const addonTotal = addons.reduce((sum, addon) => sum + (ADDON_PRICES[addon] || 0), 0);

    const amcCovered = !!amc_plan;
    const chargeableBase = amcCovered ? 0 : basePrice;
    const total = chargeableBase + addonTotal;
    const gst = Math.round(total * 0.18);
    const grandTotal = Math.round(total + gst);

    return {
      base_price: basePrice,
      amc_covered: amcCovered,
      addon_total: addonTotal,
      discount_amount: amcCovered ? basePrice : 0,
      subtotal: Math.round(total),
      gst,
      grand_total: grandTotal,
      amount_paise: grandTotal * 100,
      tanks_count: tanks ? tanks.length : 1,
    };
  },

  // Get available slots for a date
  getAvailableSlots: async (date) => {
    const bookedSlots = await BookingRepository.getAvailableSlots(date);

    // All possible slots (8 AM to 6 PM, every 2 hours)
    const allSlots = [
      '08:00', '10:00', '12:00', '14:00', '16:00', '18:00'
    ];

    const bookedTimes = bookedSlots.map(slot => {
      const d = new Date(slot.scheduled_at);
      return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
    });

    return allSlots.map(slot => ({
      time: slot,
      available: !bookedTimes.includes(slot),
    }));
  },

  // Create a new booking and auto-create a job
  createBooking: async (customerId, data) => {
    // 1. Validate tank type
    const validTankTypes = ['overhead', 'underground', 'sump'];
    if (!validTankTypes.includes(data.tank_type)) {
      throw { status: 400, message: 'Invalid tank type. Must be overhead, underground or sump.' };
    }

    // 2. Validate payment method
    const validPayments = ['upi', 'card', 'wallet', 'cod'];
    if (!validPayments.includes(data.payment_method)) {
      throw { status: 400, message: 'Invalid payment method.' };
    }

    // 3. Auto-detect active AMC for this customer
    let activePlan = null;
    try {
      const contracts = await AmcRepository.findByCustomer(customerId);
      const active = contracts.find(c => c.status === 'active');
      if (active) activePlan = active.plan_type;
    } catch (_) {}

    // 3b. Check last EcoScore for loyalty discount (score ≥ 80 → 10% off, score ≥ 60 → 5% off)
    let ecoDiscount = 0;
    let ecoDiscountLabel = null;
    try {
      const lastScore = await EcoScoreRepository.findLatestByCustomer(customerId);
      if (lastScore) {
        if (lastScore.eco_score >= 80) { ecoDiscount = 10; ecoDiscountLabel = 'EcoLoyalty 10% off (score ≥80)'; }
        else if (lastScore.eco_score >= 60) { ecoDiscount = 5; ecoDiscountLabel = 'EcoLoyalty 5% off (score ≥60)'; }
      }
    } catch (_) {}

    // 4. Calculate price (AMC discount applied automatically if active)
    const tanks = data.tanks && data.tanks.length > 0 ? data.tanks : null;
    const rawPricing = BookingService.calculatePrice(
      data.tank_type,
      data.tank_size_litres,
      data.addons,
      activePlan,
      tanks
    );

    // Apply eco loyalty discount on subtotal (only when not AMC-covered base)
    let pricing = rawPricing;
    if (ecoDiscount > 0 && rawPricing.grand_total > 0) {
      const discountAmt = Math.round(rawPricing.subtotal * ecoDiscount / 100);
      const newTotal = Math.max(0, rawPricing.subtotal - discountAmt);
      const newGst = Math.round(newTotal * 0.18);
      const newGrand = newTotal + newGst;
      pricing = {
        ...rawPricing,
        eco_discount_pct: ecoDiscount,
        eco_discount_amount: discountAmt,
        eco_discount_label: ecoDiscountLabel,
        subtotal: newTotal,
        gst: newGst,
        grand_total: newGrand,
        amount_paise: newGrand * 100,
      };
    }

    // 5. Create booking
    const firstTank = tanks ? tanks[0] : null;
    const booking = await BookingRepository.create({
      customer_id: customerId,
      tank_type: firstTank ? firstTank.tank_type : data.tank_type,
      tank_size_litres: firstTank ? firstTank.tank_size_litres : data.tank_size_litres,
      tanks: tanks,
      address: data.address,
      lat: data.lat || null,
      lng: data.lng || null,
      slot_time: data.slot_time,
      addons: data.addons || [],
      amc_plan: activePlan,
      payment_method: data.payment_method,
      amount_paise: pricing.amount_paise,
      property_type: data.property_type || 'residential',
      contact_name: data.contact_name || null,
      contact_phone: data.contact_phone || null,
    });

    // 6. Auto-create a job from this booking
    const job = await JobRepository.create({
      booking_id: booking.id,
      customer_id: customerId,
      scheduled_at: data.slot_time,
      location_lat: data.lat || null,
      location_lng: data.lng || null,
    });

    return {
      booking,
      job,
      pricing,
    };
  },

  // Get single booking
  getBooking: async (bookingId, userId, userRole) => {
    const booking = await BookingRepository.findById(bookingId);
    if (!booking) {
      throw { status: 404, message: 'Booking not found.' };
    }

    // Customers can only see their own bookings
    if (userRole === 'customer' && booking.customer_id !== userId) {
      throw { status: 403, message: 'Access denied.' };
    }

    return booking;
  },

  // Get all bookings for a customer
  getMyBookings: async (customerId) => {
    return await BookingRepository.findByCustomer(customerId);
  },

  // Get all bookings (admin only)
  getAllBookings: async (filters) => {
    return await BookingRepository.findAll(filters);
  },

  // Update booking status directly (admin only)
  updateBookingStatus: async (bookingId, status) => {
    const booking = await BookingRepository.findById(bookingId);
    if (!booking) throw { status: 404, message: 'Booking not found.' };
    const updated = await BookingRepository.updateStatus(bookingId, status);
    return updated;
  },

  // Cancel a booking
  cancelBooking: async (bookingId, userId, userRole) => {
    const booking = await BookingRepository.findById(bookingId);
    if (!booking) {
      throw { status: 404, message: 'Booking not found.' };
    }

    // Only customer who owns it or admin can cancel
    if (userRole === 'customer' && booking.customer_id !== userId) {
      throw { status: 403, message: 'Access denied.' };
    }

    if (booking.status === 'cancelled') {
      throw { status: 400, message: 'Booking is already cancelled.' };
    }

    if (booking.status === 'completed') {
      throw { status: 400, message: 'Cannot cancel a completed booking.' };
    }

    await BookingRepository.updateStatus(bookingId, 'cancelled');

    // Also cancel the related job
    await JobRepository.cancelByBookingId(bookingId);

    return { message: 'Booking cancelled successfully.' };
  },

};

module.exports = BookingService;