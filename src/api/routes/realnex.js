const express = require('express');
const { createRealNexService } = require('../../app/realnex');
const { lookupLocalEntityForRealNex } = require('../../app/brain');
const { requireAdminApiKey } = require('../guardrails');
const { validateBody, z } = require('../validation');

const router = express.Router();

function getRealNexService() {
  return createRealNexService();
}

const disambiguateSchema = z
  .object({
    entityId: z.string().trim().optional(),
    name: z.string().trim().optional(),
    email: z.string().trim().optional(),
    phone: z.string().trim().optional(),
    company: z.string().trim().optional(),
    limit: z.coerce.number().int().min(1).max(25).optional(),
    pageSize: z.coerce.number().int().min(1).max(50).optional(),
    contactLimit: z.coerce.number().int().min(1).max(500).optional(),
    companyLimit: z.coerce.number().int().min(1).max(500).optional()
  })
  .refine(
    (value) =>
      Boolean(value.entityId || value.name || value.email || value.phone || value.company),
    {
      message: 'entityId, name, email, phone, or company is required'
    }
  );

router.get('/api/realnex/contacts', requireAdminApiKey, async (req, res, next) => {
  try {
    return res.json(
      await getRealNexService().listContacts({
        top: req.query.top,
        skip: req.query.skip,
        count: String(req.query.count || '').trim().toLowerCase() === 'true'
      })
    );
  } catch (error) {
    return next(error);
  }
});

router.get('/api/realnex/contacts/:key', requireAdminApiKey, async (req, res, next) => {
  try {
    return res.json(await getRealNexService().getContact(req.params.key));
  } catch (error) {
    return next(error);
  }
});

router.get('/api/realnex/companies/:key', requireAdminApiKey, async (req, res, next) => {
  try {
    return res.json(await getRealNexService().getCompany(req.params.key));
  } catch (error) {
    return next(error);
  }
});

router.get('/api/realnex/properties/:key', requireAdminApiKey, async (req, res, next) => {
  try {
    return res.json(await getRealNexService().getProperty(req.params.key));
  } catch (error) {
    return next(error);
  }
});

router.post(
  '/api/realnex/disambiguate',
  requireAdminApiKey,
  validateBody(disambiguateSchema),
  async (req, res, next) => {
    try {
      const body = req.validatedBody || {};
      const context = await lookupLocalEntityForRealNex({
        entityId: body.entityId,
        name: body.name,
        email: body.email,
        phone: body.phone,
        company: body.company
      });
      const disambiguation = await getRealNexService().disambiguate(context.disambiguation_input, {
        limit: body.limit,
        pageSize: body.pageSize,
        contactLimit: body.contactLimit,
        companyLimit: body.companyLimit
      });

      return res.json({
        entity: context.entity,
        ...disambiguation
      });
    } catch (error) {
      return next(error);
    }
  }
);

module.exports = router;
