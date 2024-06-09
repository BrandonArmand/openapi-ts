import camelcase from 'camelcase';

import {
  ClassElement,
  type Comments,
  compiler,
  FunctionParameter,
  type Node,
  TypeScriptFile,
} from '../../compiler';
import type { ObjectValue } from '../../compiler/types';
import type {
  Model,
  Operation,
  OperationParameter,
  Service,
} from '../../openApi';
import type { Client } from '../../types/client';
import { getConfig, isStandaloneClient } from '../config';
import { escapeComment, escapeName } from '../escape';
import { transformServiceName } from '../transform';
import { unique } from '../unique';
import { uniqueTypeName } from './type';

type OnNode = (node: Node) => void;
type OnImport = (name: string) => void;

const generateImport = ({
  meta,
  onImport,
  ...uniqueTypeNameArgs
}: Pick<Parameters<typeof uniqueTypeName>[0], 'client' | 'nameTransformer'> &
  Pick<Model, 'meta'> & {
    onImport: OnImport;
  }) => {
  // generate imports only for top-level models
  if (!meta) {
    return;
  }

  const { name } = uniqueTypeName({ meta, ...uniqueTypeNameArgs });
  if (name) {
    onImport(name);
  }
};

export const operationDataTypeName = (name: string) =>
  `${camelcase(name, { pascalCase: true })}Data`;

export const operationErrorTypeName = (name: string) =>
  `${camelcase(name, { pascalCase: true })}Error`;

export const operationResponseTypeName = (name: string) =>
  `${camelcase(name, { pascalCase: true })}Response`;

const toOperationParamType = (
  client: Client,
  operation: Operation,
): FunctionParameter[] => {
  const config = getConfig();

  const { name: importedType } = uniqueTypeName({
    client,
    meta: {
      // TODO: this should be exact ref to operation for consistency,
      // but name should work too as operation ID is unique
      $ref: operation.name,
      name: operation.name,
    },
    nameTransformer: operationDataTypeName,
  });

  const isRequired = operation.parameters.some(
    (parameter) => parameter.isRequired,
  );

  if (isStandaloneClient(config)) {
    return [
      {
        isRequired,
        name: 'options',
        type: importedType ? `Options<${importedType}>` : 'Options',
      },
    ];
  }

  if (!operation.parameters.length) {
    return [];
  }

  const getDefaultPrintable = (
    p: OperationParameter | Model,
  ): string | undefined => {
    if (p.default === undefined) {
      return undefined;
    }
    return JSON.stringify(p.default, null, 4);
  };

  // legacy configuration
  if (!config.useOptions) {
    return operation.parameters.map((p) => {
      const typePath = `${importedType}['${p.name}']`;
      return {
        default: p?.default,
        isRequired:
          (!p.isRequired && !getDefaultPrintable(p) ? '?' : '') === '',
        name: p.name,
        type: typePath,
      };
    });
  }

  return [
    {
      default: isRequired ? undefined : {},
      name: 'data',
      type: importedType,
    },
  ];
};

const toOperationReturnType = (client: Client, operation: Operation) => {
  const config = getConfig();

  let returnType = compiler.typedef.basic('void');

  // TODO: we should return nothing when results don't exist
  // can't remove this logic without removing request/name config
  // as it complicates things
  if (operation.results.length) {
    const { name: importedType } = uniqueTypeName({
      client,
      meta: {
        // TODO: this should be exact ref to operation for consistency,
        // but name should work too as operation ID is unique
        $ref: operation.name,
        name: operation.name,
      },
      nameTransformer: operationResponseTypeName,
    });
    returnType = compiler.typedef.union([importedType]);
  }

  if (config.useOptions && config.services.response === 'response') {
    returnType = compiler.typedef.basic('ApiResult', [returnType]);
  }

  if (config.client === 'angular') {
    returnType = compiler.typedef.basic('Observable', [returnType]);
  } else {
    returnType = compiler.typedef.basic('CancelablePromise', [returnType]);
  }

  return returnType;
};

const toOperationComment = (operation: Operation): Comments => {
  const config = getConfig();

  if (isStandaloneClient(config)) {
    const comment = [
      operation.deprecated && '@deprecated',
      operation.summary && escapeComment(operation.summary),
      operation.description && escapeComment(operation.description),
    ];
    return comment;
  }

  let params: string[] = [];

  if (operation.parameters.length) {
    if (config.useOptions) {
      params = [
        '@param data The data for the request.',
        ...operation.parameters.map(
          (parameter) =>
            `@param data.${parameter.name} ${parameter.description ? escapeComment(parameter.description) : ''}`,
        ),
      ];
    } else {
      params = operation.parameters.map(
        (parameter) =>
          `@param ${parameter.name} ${parameter.description ? escapeComment(parameter.description) : ''}`,
      );
    }
  }

  const comment = [
    operation.deprecated && '@deprecated',
    operation.summary && escapeComment(operation.summary),
    operation.description && escapeComment(operation.description),
    ...params,
    ...operation.results.map(
      (r) =>
        `@returns ${r.type} ${r.description ? escapeComment(r.description) : ''}`,
    ),
    '@throws ApiError',
  ];
  return comment;
};

const toRequestOptions = (operation: Operation, onClientImport?: OnImport) => {
  const config = getConfig();

  if (isStandaloneClient(config)) {
    let obj: ObjectValue[] = [
      {
        spread: 'options',
      },
    ];

    const bodyParameters = operation.parameters.filter(
      (parameter) => parameter.in === 'body' || parameter.in === 'formData',
    );
    const contents = bodyParameters
      .map((parameter) => parameter.mediaType)
      .filter(Boolean)
      .filter(unique);
    if (contents.length === 1 && contents[0] === 'multipart/form-data') {
      obj = [
        ...obj,
        {
          spread: 'formDataBodySerializer',
        },
      ];
      onClientImport?.('formDataBodySerializer');
    }

    // TODO: set parseAs to skip inference if every result has the same
    // content type. currently impossible because results do not contain
    // header information

    obj = [
      ...obj,
      {
        key: 'url',
        value: operation.path,
      },
    ];

    return compiler.types.object({
      obj,
    });
  }

  const toObj = (parameters: OperationParameter[]) =>
    parameters.reduce(
      (prev, curr) => {
        const key = curr.prop;
        const value = config.useOptions ? `data.${curr.name}` : curr.name;
        if (key === value) {
          prev[key] = key;
        } else if (escapeName(key) === key) {
          prev[key] = value;
        } else {
          prev[`'${key}'`] = value;
        }
        return prev;
      },
      {} as Record<string, unknown>,
    );

  const obj: Record<string, any> = {
    method: operation.method,
    url: operation.path,
  };

  if (operation.parametersPath.length) {
    obj.path = toObj(operation.parametersPath);
  }

  if (operation.parametersCookie.length) {
    obj.cookies = toObj(operation.parametersCookie);
  }

  if (operation.parametersHeader.length) {
    obj.headers = toObj(operation.parametersHeader);
  }

  if (operation.parametersQuery.length) {
    obj.query = toObj(operation.parametersQuery);
  }

  if (operation.parametersForm.length) {
    obj.formData = toObj(operation.parametersForm);
  }

  if (operation.parametersBody) {
    if (operation.parametersBody.in === 'formData') {
      if (config.useOptions) {
        obj.formData = `data.${operation.parametersBody.name}`;
      } else {
        obj.formData = operation.parametersBody.name;
      }
    }
    if (operation.parametersBody.in === 'body') {
      if (config.useOptions) {
        obj.body = `data.${operation.parametersBody.name}`;
      } else {
        obj.body = operation.parametersBody.name;
      }
    }
  }

  if (operation.parametersBody?.mediaType) {
    obj.mediaType = operation.parametersBody?.mediaType;
  }

  if (operation.responseHeader) {
    obj.responseHeader = operation.responseHeader;
  }

  if (operation.errors.length) {
    const errors: Record<number | string, string> = {};
    operation.errors.forEach((err) => {
      errors[err.code] = err.description ?? '';
    });
    obj.errors = errors;
  }

  return compiler.types.object({
    identifiers: ['body', 'cookies', 'formData', 'headers', 'path', 'query'],
    obj,
    shorthand: true,
  });
};

const toOperationStatements = (
  client: Client,
  operation: Operation,
  onClientImport?: OnImport,
) => {
  const config = getConfig();

  const options = toRequestOptions(operation, onClientImport);

  if (isStandaloneClient(config)) {
    const errorType = uniqueTypeName({
      client,
      meta: {
        // TODO: this should be exact ref to operation for consistency,
        // but name should work too as operation ID is unique
        $ref: operation.name,
        name: operation.name,
      },
      nameTransformer: operationErrorTypeName,
    }).name;
    const responseType = operation.results.length
      ? uniqueTypeName({
          client,
          meta: {
            // TODO: this should be exact ref to operation for consistency,
            // but name should work too as operation ID is unique
            $ref: operation.name,
            name: operation.name,
          },
          nameTransformer: operationResponseTypeName,
        }).name
      : 'void';
    return [
      compiler.return.functionCall({
        args: [options],
        name: `(options?.client ?? client).${operation.method.toLocaleLowerCase()}`,
        types:
          errorType && responseType
            ? [responseType, errorType]
            : errorType
              ? ['unknown', errorType]
              : responseType
                ? [responseType]
                : [],
      }),
    ];
  }

  if (config.name) {
    return [
      compiler.return.functionCall({
        args: [options],
        name: 'this.httpRequest.request',
      }),
    ];
  }

  if (config.client === 'angular') {
    return [
      compiler.return.functionCall({
        args: ['OpenAPI', 'this.http', options],
        name: '__request',
      }),
    ];
  }

  return [
    compiler.return.functionCall({
      args: ['OpenAPI', options],
      name: '__request',
    }),
  ];
};

export const processService = (
  client: Client,
  service: Service,
  onNode: OnNode,
  onImport: OnImport,
  onClientImport: OnImport,
) => {
  const config = getConfig();

  const isStandalone = isStandaloneClient(config);

  service.operations.forEach((operation) => {
    if (operation.parameters.length) {
      generateImport({
        client,
        meta: {
          // TODO: this should be exact ref to operation for consistency,
          // but name should work too as operation ID is unique
          $ref: operation.name,
          name: operation.name,
        },
        nameTransformer: operationDataTypeName,
        onImport,
      });
    }

    if (isStandalone) {
      generateImport({
        client,
        meta: {
          // TODO: this should be exact ref to operation for consistency,
          // but name should work too as operation ID is unique
          $ref: operation.name,
          name: operation.name,
        },
        nameTransformer: operationErrorTypeName,
        onImport,
      });
    }

    // TODO: improve response type detection
    if (operation.results.length) {
      generateImport({
        client,
        meta: {
          // TODO: this should be exact ref to operation for consistency,
          // but name should work too as operation ID is unique
          $ref: operation.name,
          name: operation.name,
        },
        nameTransformer: operationResponseTypeName,
        onImport,
      });
    }
  });

  if (!config.services.asClass) {
    service.operations.forEach((operation) => {
      const expression = compiler.types.function({
        parameters: toOperationParamType(client, operation),
        returnType: isStandalone
          ? undefined
          : toOperationReturnType(client, operation),
        statements: toOperationStatements(client, operation, onClientImport),
      });
      const statement = compiler.export.const({
        comment: toOperationComment(operation),
        expression,
        name: operation.name,
      });
      onNode(statement);
    });
    return;
  }

  const members: ClassElement[] = service.operations.map((operation) => {
    const node = compiler.class.method({
      accessLevel: 'public',
      comment: toOperationComment(operation),
      isStatic: config.name === undefined && config.client !== 'angular',
      name: operation.name,
      parameters: toOperationParamType(client, operation),
      returnType: isStandalone
        ? undefined
        : toOperationReturnType(client, operation),
      statements: toOperationStatements(client, operation, onClientImport),
    });
    return node;
  });

  // Push to front constructor if needed
  if (config.name) {
    members.unshift(
      compiler.class.constructor({
        multiLine: false,
        parameters: [
          {
            accessLevel: 'public',
            isReadOnly: true,
            name: 'httpRequest',
            type: 'BaseHttpRequest',
          },
        ],
      }),
    );
  } else if (config.client === 'angular') {
    members.unshift(
      compiler.class.constructor({
        multiLine: false,
        parameters: [
          {
            accessLevel: 'public',
            isReadOnly: true,
            name: 'http',
            type: 'HttpClient',
          },
        ],
      }),
    );
  }

  const statement = compiler.class.create({
    decorator:
      config.client === 'angular'
        ? { args: [{ providedIn: 'root' }], name: 'Injectable' }
        : undefined,
    members,
    name: transformServiceName(service.name),
  });
  onNode(statement);
};

export const processServices = async ({
  client,
  files,
}: {
  client: Client;
  files: Record<string, TypeScriptFile>;
}): Promise<void> => {
  if (!files.services) {
    return;
  }

  const config = getConfig();

  let imports: string[] = [];
  let clientImports: string[] = [];

  for (const service of client.services) {
    processService(
      client,
      service,
      (node) => {
        files.services?.add(node);
      },
      (imported) => {
        imports = [...imports, imported];
      },
      (imported) => {
        clientImports = [...clientImports, imported];
      },
    );
  }

  // Import required packages and core files.
  if (isStandaloneClient(config)) {
    files.services?.addImport(
      [
        'client',
        {
          asType: true,
          name: 'Options',
        },
        ...clientImports.filter(unique),
      ],
      config.client,
    );
  } else {
    if (config.client === 'angular') {
      files.services?.addImport('Injectable', '@angular/core');

      if (!config.name) {
        files.services?.addImport('HttpClient', '@angular/common/http');
      }

      files.services?.addImport({ asType: true, name: 'Observable' }, 'rxjs');
    } else {
      files.services?.addImport(
        { asType: true, name: 'CancelablePromise' },
        './core/CancelablePromise',
      );
    }

    if (config.services.response === 'response') {
      files.services?.addImport(
        { asType: true, name: 'ApiResult' },
        './core/ApiResult',
      );
    }

    if (config.name) {
      files.services?.addImport(
        { asType: config.client !== 'angular', name: 'BaseHttpRequest' },
        './core/BaseHttpRequest',
      );
    } else {
      files.services?.addImport('OpenAPI', './core/OpenAPI');
      files.services?.addImport(
        { alias: '__request', name: 'request' },
        './core/request',
      );
    }
  }

  // Import all models required by the services.
  if (files.types && !files.types.isEmpty()) {
    const importedTypes = imports
      .filter(unique)
      .map((name) => ({ asType: true, name }));
    files.services?.addImport(importedTypes, `./${files.types.getName(false)}`);
  }
};
