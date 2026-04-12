const express = require('express');
const {
  createRealNexService,
  disambiguateLocalEntityAgainstRealNex,
  importRealNexMatchToBrain
} = require('../../app/realnex');
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

const importSchema = z
  .object({
    entityId: z.string().trim().optional(),
    key: z.string().trim().optional(),
    kind: z.enum(['contact', 'company']).optional(),
    name: z.string().trim().optional(),
    email: z.string().trim().optional(),
    phone: z.string().trim().optional(),
    company: z.string().trim().optional(),
    minScore: z.coerce.number().int().min(1).max(100).optional(),
    limit: z.coerce.number().int().min(1).max(25).optional(),
    pageSize: z.coerce.number().int().min(1).max(50).optional(),
    contactLimit: z.coerce.number().int().min(1).max(500).optional(),
    companyLimit: z.coerce.number().int().min(1).max(500).optional()
  })
  .refine(
    (value) =>
      Boolean(
        (value.key && value.kind) ||
          value.entityId ||
          value.name ||
          value.email ||
          value.phone ||
          value.company
      ),
    {
      message: 'Either key+kind or entityId, name, email, phone, or company is required'
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
      return res.json(
        await disambiguateLocalEntityAgainstRealNex(body, {
          service: getRealNexService(),
          limit: body.limit,
          pageSize: body.pageSize,
          contactLimit: body.contactLimit,
          companyLimit: body.companyLimit
        })
      );
    } catch (error) {
      return next(error);
    }
  }
);

async function importHandler(req, res, next) {
  try {
    const body = req.validatedBody || {};
    return res.json(
      await importRealNexMatchToBrain(body, {
        service: getRealNexService(),
        minScore: body.minScore,
        limit: body.limit,
        pageSize: body.pageSize,
        contactLimit: body.contactLimit,
        companyLimit: body.companyLimit,
        createKnowledge: true
      })
    );
  } catch (error) {
    return next(error);
  }
}

router.post(
  '/api/realnex/import',
  requireAdminApiKey,
  validateBody(importSchema),
  importHandler
);

router.post(
  '/api/realnex/sync',
  requireAdminApiKey,
  validateBody(importSchema),
  importHandler
);

module.exports = router;
