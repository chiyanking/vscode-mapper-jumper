const assert = require('node:assert/strict');
const test = require('node:test');
const {
  findJavaMethodNameOffsets,
  findJavaTypeNameOffset,
} = require('../out/javaScanner');

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

test('finds the mapper type declaration and ignores comments', () => {
  const source = `
// interface LmsDeliveryMsOutboundOrderReqMapper {}
public interface LmsDeliveryMsOutboundOrderReqMapper {
}`;
  assert.equal(
    findJavaTypeNameOffset(source, 'LmsDeliveryMsOutboundOrderReqMapper'),
    source.lastIndexOf('LmsDeliveryMsOutboundOrderReqMapper')
  );
});
