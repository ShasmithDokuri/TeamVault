const workspaceRepository = require('../workspaces/repository');

function createWorkspaceService(repository = workspaceRepository) {
  return Object.freeze({
    createWorkspaceForUser: (input) => repository.createWorkspaceForUser(input),
    deleteWorkspaceForOwner: (input) => repository.deleteWorkspaceForOwner(input),
    getWorkspaceForMember: (input) => repository.getWorkspaceForMember(input),
    listMembersForMember: (input) => repository.listMembersForMember(input),
    listWorkspacesForUser: (input) => repository.listWorkspacesForUser(input),
    addMemberForManager: (input) => repository.addMemberForManager(input),
    removeMemberForManager: (input) => repository.removeMemberForManager(input),
    updateMemberRoleForOwner: (input) => repository.updateMemberRoleForOwner(input),
    updateWorkspaceForManager: (input) => repository.updateWorkspaceForManager(input),
  });
}

module.exports = { createWorkspaceService };
