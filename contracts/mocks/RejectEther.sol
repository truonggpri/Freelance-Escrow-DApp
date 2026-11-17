// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IEscrowSubmit {
    function submitWork(uint256 jobId, string calldata proof) external;
    function withdraw() external;
}

/// @dev Test-only freelancer that can submit work and try to withdraw, but cannot accept ETH.
contract RejectEther {
    function submit(address escrow, uint256 jobId, string calldata proof) external {
        IEscrowSubmit(escrow).submitWork(jobId, proof);
    }

    function pull(address escrow) external {
        IEscrowSubmit(escrow).withdraw();
    }

    receive() external payable {
        revert("Rejecting ETH");
    }
}
