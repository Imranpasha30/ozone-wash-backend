const express = require('express');
const router = express.Router();

const authRoutes = require('../modules/auth/auth.routes');
const bookingRoutes = require('../modules/bookings/booking.routes');
const jobRoutes = require('../modules/jobs/job.routes');
const complianceRoutes = require('../modules/compliance/compliance.routes');
const ecoScoreRoutes = require('../modules/ecoscore/ecoscore.routes');
const certificateRoutes = require('../modules/certificates/certificate.routes');
const amcRoutes = require('../modules/amc/amc.routes');

router.use('/auth', authRoutes);
router.use('/bookings', bookingRoutes);
router.use('/jobs', jobRoutes);
router.use('/compliance', complianceRoutes);
router.use('/ecoscore', ecoScoreRoutes);
router.use('/certificates', certificateRoutes);
router.use('/amc', amcRoutes);


router.get('/health', (req, res) => {
  res.json({
    status: 'OK',
    service: 'Ozone Wash API',
    timestamp: new Date().toISOString(),
  });
});

module.exports = router;