const assert = require('node:assert/strict');
const test = require('node:test');
const {
  findDottedPathAtOffset,
  findOpenTagAtOffset,
  findPlaceholderPathAtOffset,
  getOpenTagStack,
  scanXmlTags,
} = require('../out/xmlScanner');

test('parses single quotes, spaced equals and arbitrary attribute order', () => {
  const text = `<mapper other="x" namespace = 'com.example.UserMapper'>`;
  const [mapper] = scanXmlTags(text);
  assert.equal(mapper.name, 'mapper');
  assert.equal(
    mapper.attributes.get('namespace').value,
    'com.example.UserMapper'
  );
});

test('does not treat greater-than inside an attribute as the tag end', () => {
  const text = `<if test="age > 18 and enabled">ok</if>`;
  const tags = scanXmlTags(text);
  const cursor = text.indexOf('18');
  const tag = findOpenTagAtOffset(tags, cursor);
  assert.equal(tag.name, 'if');
  assert.equal(tag.attributes.get('test').value, 'age > 18 and enabled');
});

test('records the exact value range when attribute name equals value', () => {
  const text = `<select id="id">select 1</select>`;
  const [select] = scanXmlTags(text);
  const attr = select.attributes.get('id');
  assert.equal(text.slice(attr.valueStart, attr.valueEnd), 'id');
  assert.equal(attr.valueStart, text.indexOf('"id"') + 1);
});

test('ignores tags inside comments and CDATA', () => {
  const text = `<!-- <select id="wrong"> --><![CDATA[<if test="x > 1">]]><select id="right">`;
  const tags = scanXmlTags(text);
  assert.deepEqual(
    tags.filter((tag) => !tag.closing).map((tag) => tag.name),
    ['select']
  );
  assert.equal(tags[0].attributes.get('id').value, 'right');
});

test('maintains the actual ancestor stack across closed associations', () => {
  const text = [
    `<resultMap id="user" type="com.example.User">`,
    `  <association property="address" javaType="com.example.Address">`,
    `    <result property="city"/>`,
    `  </association>`,
    `  <result property="name"/>`,
    `</resultMap>`,
  ].join('\n');
  const tags = scanXmlTags(text);
  const cityStack = getOpenTagStack(tags, text.indexOf('city'));
  const nameStack = getOpenTagStack(tags, text.indexOf('name'));
  assert.deepEqual(cityStack.map((tag) => tag.name), [
    'resultMap',
    'association',
    'result',
  ]);
  assert.deepEqual(nameStack.map((tag) => tag.name), ['resultMap', 'result']);
});

test('finds the active segment in a dotted test expression', () => {
  const text = `<if test="user.address.city != null">`;
  assert.deepEqual(findDottedPathAtOffset(text, text.indexOf('address') + 2), {
    segments: ['user', 'address', 'city'],
    activeIndex: 1,
  });
});

test('finds DTO properties inside chained OGNL method calls', () => {
  const cases = [
    `<if test="'2'.toString().equals(dto.deliveryType)">`,
    `<when test="'05'.equals(dto.planType)">`,
  ];
  assert.deepEqual(
    findDottedPathAtOffset(cases[0], cases[0].indexOf('deliveryType') + 2),
    { segments: ['dto', 'deliveryType'], activeIndex: 1 }
  );
  assert.deepEqual(
    findDottedPathAtOffset(cases[1], cases[1].indexOf('planType') + 2),
    { segments: ['dto', 'planType'], activeIndex: 1 }
  );
});

test('finds a binding path inside a placeholder and ignores options', () => {
  const text = `where name = #{request.user.name, jdbcType=VARCHAR}`;
  assert.deepEqual(findPlaceholderPathAtOffset(text, text.indexOf('name,') + 1), {
    segments: ['request', 'user', 'name'],
    activeIndex: 2,
  });
  assert.equal(
    findPlaceholderPathAtOffset(text, text.indexOf('VARCHAR') + 1),
    undefined
  );
});
