const assert = require('node:assert/strict');
const test = require('node:test');
const { findJavaMethodNameOffsets } = require('../out/javaScanner');

test('finds declarations but ignores Javadoc links and method calls', () => {
  const source = `
interface UserMapper {
  /** See findById(Long). */
  default User helper(Long id) {
    return findById(id);
  }

  User findById(Long id);
}`;
  const offsets = findJavaMethodNameOffsets(source, 'findById');
  assert.deepEqual(offsets, [source.lastIndexOf('findById')]);
});

test('supports annotated and multiline mapper declarations', () => {
  const source = `
interface UserMapper {
  @Deprecated
  java.util.List<User>
  findAll(
    String name
  );
}`;
  assert.deepEqual(findJavaMethodNameOffsets(source, 'findAll'), [
    source.indexOf('findAll'),
  ]);
});
