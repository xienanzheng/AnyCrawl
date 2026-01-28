/**
 * Response serialization utilities
 * Converts database query results (camelCase) to API responses (snake_case)
 */

/**
 * Convert a camelCase string to snake_case
 */
function camelToSnake(str: string): string {
    return str.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

/**
 * Convert an object's keys from camelCase to snake_case recursively
 */
export function toSnakeCase<T = any>(obj: any): T {
    if (obj === null || obj === undefined) {
        return obj;
    }

    // Handle arrays
    if (Array.isArray(obj)) {
        return obj.map((item) => toSnakeCase(item)) as any;
    }

    // Handle Date objects
    if (obj instanceof Date) {
        return obj as any;
    }

    // Handle primitive types
    if (typeof obj !== "object") {
        return obj;
    }

    // Handle objects
    const result: any = {};
    for (const key in obj) {
        if (Object.prototype.hasOwnProperty.call(obj, key)) {
            const snakeKey = camelToSnake(key);
            const value = obj[key];

            // Recursively convert nested objects and arrays
            if (value !== null && typeof value === "object" && !(value instanceof Date)) {
                result[snakeKey] = toSnakeCase(value);
            } else {
                result[snakeKey] = value;
            }
        }
    }

    return result;
}

/**
 * Serialize a single database record to snake_case API response
 */
export function serializeRecord<T = any>(record: any): T {
    return toSnakeCase<T>(record);
}

/**
 * Serialize an array of database records to snake_case API responses
 */
export function serializeRecords<T = any>(records: any[]): T[] {
    return records.map((record) => toSnakeCase<T>(record));
}
