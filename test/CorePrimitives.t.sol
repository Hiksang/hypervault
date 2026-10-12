// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {CoreActions} from "../src/CoreActions.sol";
import {CoreRead} from "../src/CoreRead.sol";

interface Vm {
    function expectRevert() external;
    function mockCall(address callee, bytes calldata data, bytes calldata result) external;
    function mockCallRevert(address callee, bytes calldata data, bytes calldata result) external;
}

contract Harness {
    function convert(uint256 amount, uint8 decimals) external pure returns (uint64) {
        return CoreActions.evmToCoreWei(amount, decimals);
    }

    function supply(uint256 amount) external pure returns (bytes memory) {
        return CoreActions.lend(CoreActions.LendingOperation.Supply, 0, amount);
    }

    function reserve() external view returns (CoreRead.Reserve memory) {
        return CoreRead.reserve(0);
    }

    function exists(address user) external view returns (bool) {
        return CoreRead.userExists(user);
    }

    function lending(address user) external view returns (CoreRead.UserLending memory) {
        return CoreRead.lending(user, 0);
    }
}

contract CorePrimitivesTest {
    Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    Harness h = new Harness();

    function testFuzzLendingEncoding(uint64 token, uint64 amount) public pure {
        if (amount == 0) return;
        bytes memory actual = CoreActions.lend(CoreActions.LendingOperation.Supply, token, amount);
        bytes memory expected = bytes.concat(hex"0100000f", abi.encode(uint8(0), token, amount));
        require(keccak256(actual) == keccak256(expected), "incorrect action encoding");
        require(actual.length == 100, "incorrect encoded length");
    }

    function testMaxWithdrawalIsExplicit() public pure {
        require(
            keccak256(CoreActions.withdrawAll(0))
                == keccak256(bytes.concat(hex"0100000f", abi.encode(uint8(1), uint64(0), uint64(0))))
        );
    }

    function testSupplyZeroCannotAccidentallyMeanAll() public {
        vm.expectRevert();
        h.supply(0);
    }

    function testAmountOverflowCannotTruncate() public {
        vm.expectRevert();
        h.supply(uint256(type(uint64).max) + 1);
    }

    function testDustIsRejected() public {
        vm.expectRevert();
        h.convert(1 ether + 1, 8);
    }

    function testUnsupportedDecimalsRejected() public {
        vm.expectRevert();
        h.convert(1 ether, 19);
    }

    function testFuzzExactConversion(uint64 coreWei) public view {
        require(h.convert(uint256(coreWei) * 1e10, 8) == coreWei);
    }

    function testRecallCanOnlyTargetHypeSystemAddress() public pure {
        bytes memory expected = bytes.concat(
            hex"0100000d",
            abi.encode(
                address(0x2222222222222222222222222222222222222222),
                address(0),
                type(uint32).max,
                type(uint32).max,
                uint64(150),
                uint64(1e8)
            )
        );
        require(keccak256(CoreActions.recallHype(150, 1e8)) == keccak256(expected));
    }

    function testPortfolioMarginEncoding() public pure {
        require(
            keccak256(CoreActions.setAbstraction(address(123), CoreActions.Abstraction.PortfolioMargin))
                == keccak256(bytes.concat(hex"01000010", abi.encode(address(123), uint8(3))))
        );
    }

    function testReduceOnlyExitOrderEncoding() public pure {
        bytes memory expected = bytes.concat(
            hex"01000001", abi.encode(uint32(159), true, uint64(4e9), uint64(1e8), true, uint8(3), uint128(42))
        );
        require(keccak256(CoreActions.order(159, true, 4e9, 1e8, true, 3, 42)) == keccak256(expected));
    }

    function testMissingPrecompileFailsClosed() public {
        vm.expectRevert();
        h.reserve();
    }

    function testRevertingPrecompileFailsClosed() public {
        vm.mockCallRevert(address(0x0812), abi.encode(uint64(0)), bytes("invalid token"));
        vm.expectRevert();
        h.reserve();
    }

    function testMalformedPrecompileFailsClosed() public {
        vm.mockCall(address(0x0812), abi.encode(uint64(0)), abi.encode(uint64(99)));
        vm.expectRevert();
        h.reserve();
    }

    function testReserveAbiDecoding() public {
        vm.mockCall(
            address(0x0812),
            abi.encode(uint64(0)),
            abi.encode(
                uint64(500), uint64(300), uint64(1000), uint64(6000), uint64(1e8), uint64(0), uint64(2000), uint64(1000)
            )
        );
        CoreRead.Reserve memory r = h.reserve();
        require(r.borrowYearlyRateBps == 500 && r.totalBorrowed == 1000 && r.utilizationBps == 6000);
    }

    function testUserLendingAbiDecoding() public {
        vm.mockCall(
            address(0x0811),
            abi.encode(address(123), uint64(0)),
            abi.encode(uint64(10), uint64(11), uint64(20), uint64(22))
        );
        CoreRead.UserLending memory s = h.lending(address(123));
        require(s.borrow.basis == 10 && s.borrow.value == 11 && s.supply.basis == 20 && s.supply.value == 22);
    }

    function testAccountExistenceUsesRawArguments() public {
        vm.mockCall(address(0x0810), abi.encode(address(123)), abi.encode(true));
        require(h.exists(address(123)));
    }
}
