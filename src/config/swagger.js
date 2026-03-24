const swaggerJsdoc = require('swagger-jsdoc');

const options = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'Ozone Wash API',
      version: '1.0.0',
      description: 'API documentation for Ozone Wash Platform — VijRam Health Sense Pvt. Ltd.',
    },
    servers: [
      {
        url: 'http://localhost:3000/api/v1',
        description: 'Development server',
      },
    ],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          description: 'Enter your JWT token from /auth/verify-otp response',
        },
      },
    },
    security: [{ bearerAuth: [] }],
  },
  // This tells swagger-jsdoc where to find your route files
  apis: ['./src/modules/**/*.routes.js'],
};

const swaggerSpec = swaggerJsdoc(options);

module.exports = swaggerSpec;