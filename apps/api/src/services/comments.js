const commentRepository = require('../comments/repository');

function createCommentService(repository = commentRepository) {
  return Object.freeze({
    createComment: (input) => repository.createComment(input),
    deleteComment: (input) => repository.deleteComment(input),
    listCommentsForMember: (input) => repository.listCommentsForMember(input),
    updateComment: (input) => repository.updateComment(input),
  });
}

module.exports = { createCommentService };
