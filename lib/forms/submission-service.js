'use strict';

const { validateSubmissionValues } = require('./schema');

function validationError(errors) {
  return {
    error: {
      code: 'validation_error',
      message: 'Submission validation failed.',
      details: errors.map((error) => ({ path: error.path, message: error.message })),
    },
  };
}

function requestError(message) {
  return {
    error: {
      code: 'invalid_request',
      message,
      details: [],
    },
  };
}

function selectedOptions(field, value) {
  if (field.type !== 'select' && field.type !== 'multi-select') return undefined;
  if (!Array.isArray(field.options)) return null;
  const selectedIds = field.type === 'select' ? [value] : value;
  return selectedIds.map((optionId) => {
    const option = field.options.find((candidate) => candidate.id === optionId);
    return option ? { optionId, optionLabel: option.label } : null;
  });
}

class SubmissionService {
  constructor({ registry, store }) {
    if (!registry || typeof registry.getTemplate !== 'function') throw new Error('registry is required.');
    if (!store || typeof store.createSubmission !== 'function') throw new Error('store is required.');
    this.registry = registry;
    this.store = store;
  }

  async submit(input) {
    const temporalFields = ['eventAt', 'timezone', 'clientOffsetMinutes']
      .filter((key) => input[key] !== undefined);
    if (temporalFields.length !== 0 && temporalFields.length !== 3) {
      return validationError([{
        path: 'eventTime',
        message: 'eventAt, timezone, and clientOffsetMinutes must be supplied together',
      }]);
    }
    const registered = await this.registry.getTemplate(input.templateId);
    if (!registered) return { error: { code: 'not_found', message: 'Form not found.' } };
    const { schemaDigest, ...template } = registered;
    const validation = validateSubmissionValues(template, input.values);
    if (!validation.valid) return validationError(validation.errors);

    const capturedValues = [];
    for (const field of template.fields) {
      if (!Object.prototype.hasOwnProperty.call(validation.normalized, field.id)) continue;
      const value = validation.normalized[field.id];
      const snapshots = selectedOptions(field, value);
      if (snapshots === null || (Array.isArray(snapshots) && snapshots.some((entry) => entry === null))) {
        return validationError([{
          path: `values.${field.id}`,
          message: 'cannot resolve selected option labels from this template',
        }]);
      }
      capturedValues.push({
        fieldId: field.id,
        fieldType: field.type,
        fieldLabel: field.label,
        value,
        ...(snapshots === undefined ? {} : { selectedOptions: snapshots }),
      });
    }

    let record;
    try {
      record = await this.store.createSubmission({
        actor: input.actor,
        templateId: template.templateId,
        templateVersion: template.revision,
        schemaDigest,
        values: capturedValues,
        ...(input.eventAt === undefined ? {} : {
          eventAt: input.eventAt,
          timezone: input.timezone,
          clientOffsetMinutes: input.clientOffsetMinutes,
        }),
        ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
      });
    } catch (error) {
      if (error && error.code === 'EVALIDATION') {
        return requestError(error.message);
      }
      if (error && error.code === 'ECONFLICT') {
        return {
          error: {
            code: 'idempotency_conflict',
            message: 'The idempotency key was already used for a different submission.',
            details: [],
          },
        };
      }
      throw error;
    }
    return { submissionId: record.submissionId, receipt: record };
  }
}

module.exports = {
  SubmissionService,
};
