// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IEscrowSubmit {
    function submitWork(uint256 jobId, string calldata proof) external;
}

/// @dev Test-only freelancer that can submit work but cannot accept ETH.
contract RejectEther {
    function submit(address escrow, uint256 jobId, string calldata proof) external {
        IEscrowSubmit(escrow).submitWork(jobId, proof);
    }

    receive() external payable {
        revert("Rejecting ETH");
    }
}
