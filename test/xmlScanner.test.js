const assert = require('node:assert/strict');
const test = require('node:test');
const {
  findOpenTagAtOffset,
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

test('preserves a wildcard mapper namespace and its exact value range', () => {
  const text = `<mapper namespace="*">`;
  const [mapper] = scanXmlTags(text);
  const namespace = mapper.attributes.get('namespace');
  assert.equal(namespace.value, '*');
  assert.equal(text.slice(namespace.valueStart, namespace.valueEnd), '*');
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
