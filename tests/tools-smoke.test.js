import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { ALL_SCHEMAS } from '../dist/schemas.js';

const EXPECTED_SCHEMA_COUNT = 25;

describe('Tool Schema Smoke Tests', () => {
    const schemaNames = Object.keys(ALL_SCHEMAS);

    it(`exports exactly ${EXPECTED_SCHEMA_COUNT} schemas`, () => {
        assert.equal(schemaNames.length, EXPECTED_SCHEMA_COUNT,
            `Expected ${EXPECTED_SCHEMA_COUNT} schemas, got ${schemaNames.length}: ${schemaNames.join(', ')}`);
    });

    for (const name of schemaNames) {
        it(`${name} produces valid JSON Schema`, () => {
            const schema = ALL_SCHEMAS[name];
            const jsonSchema = z.toJSONSchema(schema);
            assert.equal(jsonSchema.type, 'object', `${name} should produce type: "object"`);
            assert.ok(jsonSchema.properties !== undefined || Object.keys(jsonSchema).length > 0,
                `${name} should have properties or be a valid object schema`);
        });
    }
});
