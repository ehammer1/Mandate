// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/**
 * @title NoticeBoard
 * @notice Permanent public text for Mandate: poll questions, mandate goals, evidence,
 *         verifiers' reasons. Each text is stored once, under the keccak256 hash of its
 *         bytes, so a reference ("nb:0x<hash>") proves exactly which words were voted
 *         on and can never be edited afterwards. No pinning service or server needed.
 *
 * Anyone may post; posting costs the poster gas, which keeps spam self-limiting.
 */
contract NoticeBoard {
    uint256 public constant MAX_BYTES = 16_384;

    mapping(bytes32 => string) private _text;
    mapping(bytes32 => address) public author;
    mapping(bytes32 => uint64) public postedAt;

    event Posted(bytes32 indexed id, address indexed author, uint256 length);

    error Empty();
    error TooLong(uint256 length);

    /// @return id keccak256 of the text. Posting text that already exists just returns its id.
    function post(string calldata text) external returns (bytes32 id) {
        uint256 len = bytes(text).length;
        if (len == 0) revert Empty();
        if (len > MAX_BYTES) revert TooLong(len);
        id = keccak256(bytes(text));
        if (postedAt[id] != 0) return id;
        _text[id] = text;
        author[id] = msg.sender;
        postedAt[id] = uint64(block.timestamp);
        emit Posted(id, msg.sender, len);
    }

    /// @notice The text stored under `id` (empty if none).
    function read(bytes32 id) external view returns (string memory) {
        return _text[id];
    }
}
