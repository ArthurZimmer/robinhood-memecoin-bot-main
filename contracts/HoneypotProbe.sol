// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title HoneypotProbe
/// @notice NEVER DEPLOYED. Injected via eth_call state override (code + balance
///         on a synthetic address) to simulate a full buy -> approve -> sell
///         round trip against a Uniswap V2 router in a single RPC call.
///
///         If any step reverts (trading paused, buyer blacklisted, sell
///         blocked), the whole call reverts and the caller treats the token as
///         a honeypot. Fee-on-transfer taxes are measured by comparing router
///         quotes against actual balance deltas.
///
///         Recompile with: npx solc --optimize --bin contracts/HoneypotProbe.sol
///         and vendor the RUNTIME bytecode into src/risk/honeypot-probe.ts.
interface IUniswapV2Router {
    function getAmountsOut(uint256 amountIn, address[] calldata path)
        external
        view
        returns (uint256[] memory amounts);

    function swapExactETHForTokens(
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external payable returns (uint256[] memory amounts);

    function swapExactTokensForETHSupportingFeeOnTransferTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external;
}

interface IERC20 {
    function balanceOf(address owner) external view returns (uint256);

    function approve(address spender, uint256 amount) external returns (bool);
}

contract HoneypotProbe {
    /// @param router  Uniswap V2 Router02 address
    /// @param weth    WETH address on this chain
    /// @param token   token under test
    /// @param amountIn ETH amount to simulate the buy with (wei)
    /// @return tokensQuoted   tokens the router quoted for the buy
    /// @return tokensReceived tokens actually credited (captures buy tax)
    /// @return ethQuoted      ETH the router quoted for selling tokensReceived
    /// @return ethReceived    ETH actually credited (captures sell tax)
    function probe(
        address router,
        address weth,
        address token,
        uint256 amountIn
    )
        external
        returns (
            uint256 tokensQuoted,
            uint256 tokensReceived,
            uint256 ethQuoted,
            uint256 ethReceived
        )
    {
        IUniswapV2Router r = IUniswapV2Router(router);

        // ── Buy quote ─────────────────────────────────────────────────────
        address[] memory buyPath = new address[](2);
        buyPath[0] = weth;
        buyPath[1] = token;
        uint256[] memory quoted = r.getAmountsOut(amountIn, buyPath);
        tokensQuoted = quoted[quoted.length - 1];

        // ── Buy (reverts here = trading closed / buy blocked) ────────────
        r.swapExactETHForTokens{value: amountIn}(
            0,
            buyPath,
            address(this),
            type(uint256).max
        );
        tokensReceived = IERC20(token).balanceOf(address(this));
        require(tokensReceived > 0, "probe: zero tokens received");

        // ── Sell quote ────────────────────────────────────────────────────
        IERC20(token).approve(router, tokensReceived);
        address[] memory sellPath = new address[](2);
        sellPath[0] = token;
        sellPath[1] = weth;
        uint256[] memory sellQuoted = r.getAmountsOut(tokensReceived, sellPath);
        ethQuoted = sellQuoted[sellQuoted.length - 1];

        // ── Sell (reverts here = classic honeypot) ────────────────────────
        uint256 balBefore = address(this).balance;
        r.swapExactTokensForETHSupportingFeeOnTransferTokens(
            tokensReceived,
            0,
            sellPath,
            address(this),
            type(uint256).max
        );
        ethReceived = address(this).balance - balBefore;
    }

    /// Router unwraps WETH and sends ETH back — must be payable.
    receive() external payable {}
}
