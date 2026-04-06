const BookingRepository = require('./booking.repository');
const JobRepository = require('../jobs/job.repository');
const AmcRepository = require('../amc/amc.repository');

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

  // Calculate price based on tank type, size, addons, AMC
  calculatePrice: (tank_type, tank_size_litres, addons = [], amc_plan = null) => {
    // Base price depends on tank type
    let basePrice = BASE_PRICES[tank_type] || 1000;

    // Extra charge for large tanks (above 1000 litres)
    if (tank_size_litres > 1000) {
      basePrice += Math.floor((tank_size_litres - 1000) / 500) * 300;
    }

    // Add addon prices
    const addonTotal = addons.reduce((sum, addon) => {
      return sum + (ADDON_PRICES[addon] || 0);
    }, 0);

    // AMC customers: base cleaning is FREE (already paid via AMC plan).
    // They only pay for optional addons.
    const amcCovered = !!amc_plan;
    const chargeableBase = amcCovered ? 0 : basePrice;

    let total = chargeableBase + addonTotal;

    // Add 18% GST on chargeable amount only
    const gst = Math.round(total * 0.18);
    const grandTotal = Math.round(total + gst);

    // Note: base_price, addon_total, gst, grand_total are all in RUPEES.
    // Only amount_paise is in paise (for Razorpay).
    return {
      base_price: basePrice,          // show original base for reference
      amc_covered: amcCovered,        // true = base is free
      addon_total: addonTotal,
      discount_amount: amcCovered ? basePrice : 0,  // full base waived
      subtotal: Math.round(total),
      gst,
      grand_total: grandTotal,
      amount_paise: grandTotal * 100,
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

    // 4. Calculate price (AMC discount applied automatically if active)
    const pricing = BookingService.calculatePrice(
      data.tank_type,
      data.tank_size_litres,
      data.addons,
      activePlan
    );

    // 5. Create booking
    const booking = await BookingRepository.create({
      customer_id: customerId,
      tank_type: data.tank_type,
      tank_size_litres: data.tank_size_litres,
      address: data.address,
      lat: data.lat || null,
      lng: data.lng || null,
      slot_time: data.slot_time,
      addons: data.addons || [],
      amc_plan: activePlan,
      payment_method: data.payment_method,
      amount_paise: pricing.amount_paise,
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