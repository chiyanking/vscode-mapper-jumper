const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');
const test = require('node:test');

class Position {
  constructor(line, character) {
    this.line = line;
    this.character = character;
  }
}

class Range {
  constructor(startOrLine, startCharacterOrEnd, endLine, endCharacter) {
    if (startOrLine instanceof Position) {
      this.start = startOrLine;
      this.end = startCharacterOrEnd;
    } else {
      this.start = new Position(startOrLine, startCharacterOrEnd);
      this.end = new Position(endLine, endCharacter);
    }
  }

  contains(position) {
    return (
      (position.line > this.start.line ||
        (position.line === this.start.line &&
          position.character >= this.start.character)) &&
      (position.line < this.end.line ||
        (position.line === this.end.line &&
          position.character <= this.end.character))
    );
  }
}

class Uri {
  constructor(fsPath) {
    this.fsPath = fsPath;
  }

  static file(fsPath) {
    return new Uri(fsPath);
  }

  static parse(value) {
    return new Uri(value.replace(/^file:\/\//, ''));
  }

  toString() {
    return `file://${this.fsPath}`;
  }
}

class Location {
  constructor(uri, range) {
    this.uri = uri;
    this.range = range;
  }
}

class TextDocument {
  constructor(fileName, languageId, text) {
    this.fileName = fileName;
    this.languageId = languageId;
    this.text = text;
    this.uri = Uri.file(fileName);
    this.lines = text.split('\n');
    this.lineCount = this.lines.length;
  }

  getText(range) {
    if (!range) return this.text;
    return this.text.slice(this.offsetAt(range.start), this.offsetAt(range.end));
  }

  lineAt(line) {
    return { text: this.lines[line] };
  }

  positionAt(offset) {
    const before = this.text.slice(0, offset);
    const lines = before.split('\n');
    return new Position(lines.length - 1, lines[lines.length - 1].length);
  }

  offsetAt(position) {
    let offset = 0;
    for (let line = 0; line < position.line; line++) {
      offset += this.lines[line].length + 1;
    }
    return offset + position.character;
  }
}

test('resolves OGNL and placeholder bindings to mapper parameters and DTO fields', async () => {
  const root = '/workspace/project';
  const mapperPath = path.join(
    root,
    'src/main/java/com/example/mapper/DeliveryMapper.java'
  );
  const dtoPath = path.join(
    root,
    'src/main/java/com/example/dto/DeliveryDto.java'
  );
  const addressPath = path.join(
    root,
    'src/main/java/com/example/dto/Address.java'
  );
  const xmlPath = path.join(
    root,
    'src/main/resources/com/example/mapper/DeliveryMapper.xml'
  );
  const documents = new Map([
    [
      mapperPath,
      new TextDocument(
        mapperPath,
        'java',
        `package com.example.mapper;
import com.example.dto.DeliveryDto;
import org.apache.ibatis.annotations.Param;

public interface DeliveryMapper {
  void update(@Param(value = "dto") DeliveryDto request);
}`
      ),
    ],
    [
      dtoPath,
      new TextDocument(
        dtoPath,
        'java',
        `package com.example.dto;

public class DeliveryDto {
  private String deliveryType;
  private String planType;
  private Address address;
}`
      ),
    ],
    [
      addressPath,
      new TextDocument(
        addressPath,
        'java',
        `package com.example.dto;

public class Address {
  private String city;
}`
      ),
    ],
    [
      xmlPath,
      new TextDocument(
        xmlPath,
        'xml',
        `<mapper namespace="com.example.mapper.DeliveryMapper">
  <update id="update">
    <when test="'05'.equals(dto.planType)">ok</when>
    update delivery set type = #{dto.deliveryType}
    and city = #{dto.address.city}
    where plan_type = #{planType}
  </update>
</mapper>`
      ),
    ],
  ]);

  const vscodeMock = {
    Position,
    Range,
    Uri,
    Location,
    SymbolKind: { Method: 1, Class: 2, Interface: 3, Enum: 4, Struct: 5 },
    commands: {
      async executeCommand() {
        throw new Error('language service unavailable in test');
      },
    },
    workspace: {
      fs: {
        async readFile(uri) {
          return Buffer.from(documents.get(uri.fsPath).getText());
        },
        async stat(uri) {
          if (!documents.has(uri.fsPath)) throw new Error('not found');
          return {};
        },
      },
      async findFiles(pattern) {
        if (pattern === '**/*.xml') return [Uri.file(xmlPath)];
        return [];
      },
      getWorkspaceFolder() {
        return undefined;
      },
      async openTextDocument(uri) {
        return documents.get(uri.fsPath);
      },
    },
  };

  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'vscode') return vscodeMock;
    return originalLoad.call(this, request, parent, isMain);
  };
  const { resolveTargets } = require('../out/jumper');
  Module._load = originalLoad;

  const xmlDoc = documents.get(xmlPath);
  const resolveAt = async (needle) => {
    const offset = xmlDoc.getText().indexOf(needle) + 1;
    return resolveTargets(xmlDoc, xmlDoc.positionAt(offset));
  };

  const [dtoParameter] = await resolveAt('dto.planType');
  assert.equal(dtoParameter.uri.fsPath, mapperPath);
  assert.equal(
    documents.get(mapperPath).getText(dtoParameter.range),
    'request'
  );

  const [planType] = await resolveAt('planType)');
  assert.equal(planType.uri.fsPath, dtoPath);
  assert.equal(documents.get(dtoPath).getText(planType.range), 'planType');

  const [deliveryType] = await resolveAt('deliveryType}');
  assert.equal(deliveryType.uri.fsPath, dtoPath);
  assert.equal(documents.get(dtoPath).getText(deliveryType.range), 'deliveryType');

  const [city] = await resolveAt('city}');
  assert.equal(city.uri.fsPath, addressPath);
  assert.equal(documents.get(addressPath).getText(city.range), 'city');

  const implicitOffset = xmlDoc.getText().lastIndexOf('planType') + 1;
  const [implicitPlanType] = await resolveTargets(
    xmlDoc,
    xmlDoc.positionAt(implicitOffset)
  );
  assert.equal(implicitPlanType.uri.fsPath, dtoPath);
  assert.equal(documents.get(dtoPath).getText(implicitPlanType.range), 'planType');
});
