import { isDefined } from '../../../utils/isDefined';
import type { Dictionary } from '../../../utils/types';
import type { OpenApi } from '../interfaces/OpenApi';
import type { OpenApiMediaType } from '../interfaces/OpenApiMediaType';
import type { OpenApiSchema } from '../interfaces/OpenApiSchema';

export interface Content {
    mediaType: string;
    schema: OpenApiSchema;
}

const BASIC_MEDIA_TYPES = [
    'application/json-patch+json',
    'application/json',
    'application/x-www-form-urlencoded',
    'text/json',
    'text/plain',
    'multipart/form-data',
    'multipart/mixed',
    'multipart/related',
    'multipart/batch',
];

export function getContent(openApi: OpenApi, content: Dictionary<OpenApiMediaType>): Content | null {
    const basicMedia = BASIC_MEDIA_TYPES.find(mediaType => isDefined(content[mediaType]?.schema));
    if (basicMedia) {
        return {
            mediaType: basicMedia,
            schema: content[basicMedia].schema as OpenApiSchema,
        };
    }

    const otherMediaTypes = Object.keys(content);
    const otherMediaType = otherMediaTypes.find(mediaType => isDefined(content[mediaType]?.schema));
    if (otherMediaType) {
        return {
            mediaType: otherMediaType,
            schema: content[otherMediaType].schema as OpenApiSchema,
        };
    }
    return null;
}
