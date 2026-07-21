'use strict';

const { validateSubmissionValues } = require('./schema');
const { storeForTemplate } = require('./destination-adapter');

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

  async submit(input, options = {}) {
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
    if (template.archived === true) {
      return {
        error: {
          code: 'archived',
          message: 'This form is archived and is not accepting new entries.',
          details: [],
        },
      };
    }
    const destinationStore = storeForTemplate(this.store, template);
    let predecessor = null;
    if (input.supersedesRecord !== undefined) {
      if (!input.supersedesRecord || input.supersedesRecord.resourceKind !== 'form-submission'
          || typeof input.supersedesRecord.id !== 'string') {
        return requestError('supersedesRecord must identify a form-submission.');
      }
      try {
        predecessor = await destinationStore.getSubmission(input.supersedesRecord.id);
      } catch (error) {
        if (!error || error.code !== 'EVALIDATION') throw error;
      }
      const sameActor = predecessor && predecessor.actor && input.actor
        && predecessor.actor.id === input.actor.id && predecessor.actor.type === input.actor.type;
      if (!predecessor || predecessor.templateId !== template.templateId
          || (!sameActor && options.correctionAuthorized !== true)) {
        return { error: { code: 'not_found', message: 'Form not found.' } };
      }
    }
    const validation = validateSubmissionValues(template, input.values);
    if (!validation.valid) return validationError(validation.errors);

    const capturedValues = [];
    for (const field of template.fields.filter((candidate) => candidate.isDestroyed !== true)) {
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
      record = await destinationStore.createSubmission({
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
        ...(input.supersedesRecord === undefined ? {} : { supersedesRecord: input.supersedesRecord }),
      }, {
        allowForeignSupersede: predecessor !== null && options.correctionAuthorized === true,
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
      if (error && error.code === 'ENOTFOUND') {
        return { error: { code: 'not_found', message: 'Form not found.' } };
      }
      if (error && error.code === 'ESUPERSEDED') {
        return {
          error: {
            code: 'correction_conflict',
            message: 'The submission has already been superseded.',
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
