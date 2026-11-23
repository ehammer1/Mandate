// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

import {AccessControlEnumerable} from "@openzeppelin/contracts/access/extensions/AccessControlEnumerable.sol";

/**
 * @title  MandateRegistry
 * @notice The public record of every mandate: a decision the public made that a
 *         named party must carry out by a deadline, with success criteria that
 *         independent verifiers check against submitted evidence.
 *
 * Lifecycle
 * ---------
 *   GOVERNOR creates a mandate          -> Active
 *   responsible party submits evidence  -> UnderReview   (opens a new review round)
 *   `threshold` verifiers approve       -> Fulfilled     (terminal)
 *   `threshold` verifiers reject        -> Active        (party may resubmit)
 *   GOVERNOR cancels (vote repealed)    -> Cancelled     (terminal)
 *
 * A mandate is *overdue* whenever it is past its deadline and neither Fulfilled
 * nor Cancelled. Enforcement modules (e.g. BudgetEscrow) read that state; the
 * registry itself holds no funds.
 *
 * Roles
 * -----
 *   DEFAULT_ADMIN_ROLE - grants/revokes roles. In production this should be a
 *                        timelock controlled by the public vote, never an EOA.
 *   GOVERNOR_ROLE      - creates and cancels mandates (the vote executor, or a
 *                        DecisionMarket after its veto window).
 *   VERIFIER_ROLE      - independent attesters (AI reviewers, human auditors,
 *                        dispute-court adapters).
 *
 * The full mandate text and its success criteria live off-chain at `specCID`
 * (IPFS, JSON); only the CID is stored so the record is immutable and cheap.
 */
contract MandateRegistry is AccessControlEnumerable {
    bytes32 public constant GOVERNOR_ROLE = keccak256("GOVERNOR_ROLE");
    bytes32 public constant VERIFIER_ROLE = keccak256("VERIFIER_ROLE");

    uint256 public constant MAX_CID_LENGTH = 128;

    enum Status {
        None,
        Active,
        UnderReview,
        Fulfilled,
        Cancelled,
        Paused // on hold for review: the deadline clock stops, budgets stay where they are
    }

    struct Mandate {
        address responsible;
        uint64 createdAt;
        uint64 deadline;
        uint64 settledAt;
        uint16 threshold;
        Status status;
        uint32 round;
        uint32 approvals;
        uint32 rejections;
        bytes32 category;
        string specCID;
        string evidenceCID;
        uint64 pausedAt; // when it was paused (0 if not paused)
    }

    uint256 public mandateCount;
    mapping(uint256 => Mandate) private _mandates;

    /// @notice mandateId => review round => verifier => has attested
    mapping(uint256 => mapping(uint32 => mapping(address => bool))) public hasAttested;

    /// @notice Random checkers: when above 0, each round of evidence is checked by a panel of
    ///         this many verifiers (at least the mandate's threshold), drawn at random once the
    ///         evidence is in; only they may attest. Nobody knows in advance who will check, so
    ///         there is nobody to lean on. 0: every verifier may check (as before).
    uint16 public panelSize;
    uint256 public constant PANEL_DELAY_BLOCKS = 5;
    uint16 public constant MAX_PANEL = 25;
    struct Panel {
        uint16 size; // wanted, fixed when the evidence came in (0: no panel)
        uint64 seedBlock;
        address[] members;
        uint64 drawnAt;
        uint16 reschedules; // public: draw blocks missed and set again, and redraws
    }
    /// @notice A drawn panel that hasn't decided within this time can be drawn again.
    uint64 public constant PANEL_TIMEOUT = 7 days;
    mapping(uint256 => mapping(uint32 => Panel)) private _panels;

    // ------------------------------------------------------------------ events

    event MandateCreated(
        uint256 indexed id,
        address indexed responsible,
        bytes32 indexed category,
        uint64 deadline,
        uint16 threshold,
        string specCID
    );
    event EvidenceSubmitted(uint256 indexed id, uint32 indexed round, string evidenceCID);
    event Attested(uint256 indexed id, uint32 indexed round, address indexed verifier, bool approve, string reasonCID);
    event EvidenceRejected(uint256 indexed id, uint32 indexed round);
    event MandateFulfilled(uint256 indexed id, uint32 round, string evidenceCID);
    event MandateCancelled(uint256 indexed id, string reasonCID);
    event MandatePaused(uint256 indexed id, string reasonCID);
    event PanelSizeSet(uint16 size);
    event PanelScheduled(uint256 indexed id, uint32 indexed round, uint64 seedBlock);
    event PanelDrawn(uint256 indexed id, uint32 indexed round, address[] members);
    event MandateRevised(uint256 indexed id, address indexed responsible, uint64 deadline, uint16 threshold, string specCID, string reasonCID);

    // ------------------------------------------------------------------ errors

    error ZeroAddress();
    error InvalidDeadline();
    error InvalidThreshold(uint16 threshold, uint256 verifierCount);
    error InvalidCID();
    error UnknownMandate(uint256 id);
    error WrongStatus(uint256 id, Status status);
    error NotResponsible();
    error AlreadyAttested();
    error ResponsibleCannotVerify();
    error NotOnPanel();
    error PanelNotReady();
    error PanelAlreadyDrawn();
    error BadPanelSize();
    error NoVerifiers();

    constructor(address admin) {
        if (admin == address(0)) revert ZeroAddress();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    // ------------------------------------------------------------- governance

    /**
     * @param responsible  Party that must carry out the mandate.
     * @param deadline     Unix timestamp by which it must be fulfilled.
     * @param threshold    Verifier agreements needed to approve (or reject) evidence.
     *                     Must not exceed the current number of verifiers.
     * @param category     Free-form tag, e.g. keccak256("records"), keccak256("budget").
     * @param specCID      IPFS CID of the mandate spec JSON (text + success criteria).
     */
    function createMandate(address responsible, uint64 deadline, uint16 threshold, bytes32 category, string calldata specCID)
        external
        onlyRole(GOVERNOR_ROLE)
        returns (uint256 id)
    {
        if (responsible == address(0)) revert ZeroAddress();
        if (deadline <= block.timestamp) revert InvalidDeadline();
        uint256 verifiers = getRoleMemberCount(VERIFIER_ROLE);
        if (threshold == 0 || threshold > verifiers) revert InvalidThreshold(threshold, verifiers);
        _checkCID(specCID);

        id = ++mandateCount;
        Mandate storage m = _mandates[id];
        m.responsible = responsible;
        m.createdAt = uint64(block.timestamp);
        m.deadline = deadline;
        m.threshold = threshold;
        m.status = Status.Active;
        m.category = category;
        m.specCID = specCID;

        emit MandateCreated(id, responsible, category, deadline, threshold, specCID);
    }

    /// @notice Repeal a mandate (e.g. the public vote reversed it). Cannot undo a fulfilled mandate.
    /// @dev Works on paused mandates too.
    function cancelMandate(uint256 id, string calldata reasonCID) external onlyRole(GOVERNOR_ROLE) {
        Mandate storage m = _get(id);
        if (m.status == Status.Fulfilled || m.status == Status.Cancelled) revert WrongStatus(id, m.status);
        m.status = Status.Cancelled;
        m.settledAt = uint64(block.timestamp);
        emit MandateCancelled(id, reasonCID);
    }

    /// @notice Put a mandate on hold for review (e.g. residents said it isn't working). Its
    ///         deadline clock stops and nothing can be paid out or forfeited until it is revised.
    function pauseMandate(uint256 id, string calldata reasonCID) external onlyRole(GOVERNOR_ROLE) {
        Mandate storage m = _get(id);
        if (m.status != Status.Active && m.status != Status.UnderReview) revert WrongStatus(id, m.status);
        m.status = Status.Paused;
        m.pausedAt = uint64(block.timestamp);
        emit MandatePaused(id, reasonCID);
    }

    /**
     * @notice Redesign a mandate (and resume it if paused): a new responsible party (a recall
     *         of the old one), more time, a different number of checks or a new goal. Any
     *         evidence under review is set aside and checking starts again.
     * @param responsible   new responsible party, or address(0) to keep the current one
     * @param extraTime     seconds added to the deadline (time spent paused is added automatically)
     * @param threshold     new number of verifier checks, or 0 to keep it
     * @param specCID       new goal text, or "" to keep it
     */
    function reviseMandate(uint256 id, address responsible, uint64 extraTime, uint16 threshold, string calldata specCID, string calldata reasonCID)
        external
        onlyRole(GOVERNOR_ROLE)
    {
        Mandate storage m = _get(id);
        if (m.status != Status.Active && m.status != Status.UnderReview && m.status != Status.Paused) revert WrongStatus(id, m.status);
        if (m.status == Status.Paused) m.deadline += uint64(block.timestamp) - m.pausedAt;
        m.deadline += extraTime;
        if (m.deadline <= block.timestamp) revert InvalidDeadline();
        if (responsible != address(0)) m.responsible = responsible;
        if (threshold != 0) {
            uint256 verifiers = getRoleMemberCount(VERIFIER_ROLE);
            if (threshold > verifiers) revert InvalidThreshold(threshold, verifiers);
            m.threshold = threshold;
        }
        if (bytes(specCID).length != 0) {
            _checkCID(specCID);
            m.specCID = specCID;
        }
        m.status = Status.Active;
        m.pausedAt = 0;
        unchecked {
            ++m.round; // earlier attestations don't carry over
        }
        m.approvals = 0;
        m.rejections = 0;
        delete m.evidenceCID;
        emit MandateRevised(id, m.responsible, m.deadline, m.threshold, m.specCID, reasonCID);
    }

    // ------------------------------------------------------- responsible party

    /// @notice Submit evidence of fulfilment. Allowed after the deadline (late compliance).
    function submitEvidence(uint256 id, string calldata evidenceCID) external {
        Mandate storage m = _get(id);
        if (msg.sender != m.responsible) revert NotResponsible();
        if (m.status != Status.Active) revert WrongStatus(id, m.status);
        _checkCID(evidenceCID);

        unchecked {
            ++m.round;
        }
        m.status = Status.UnderReview;
        m.approvals = 0;
        m.rejections = 0;
        m.evidenceCID = evidenceCID;
        emit EvidenceSubmitted(id, m.round, evidenceCID);
        if (panelSize > 0) {
            Panel storage p = _panels[id][m.round];
            p.size = panelSize < m.threshold ? m.threshold : panelSize;
            p.seedBlock = uint64(block.number + PANEL_DELAY_BLOCKS);
            emit PanelScheduled(id, m.round, p.seedBlock);
        }
    }

    // ---------------------------------------------------------- random checkers

    /// @notice Turn random checkers on (a panel size) or off (0). Admin (the council) only.
    function setPanelSize(uint16 size) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (size > MAX_PANEL) revert BadPanelSize();
        panelSize = size;
        emit PanelSizeSet(size);
    }

    /// @notice Draw this round's checkers once its seed block exists. Anyone may call it.
    ///         If nobody did within 256 blocks, it sets a new seed block instead.
    function drawPanel(uint256 id) external {
        Mandate storage m = _get(id);
        if (m.status != Status.UnderReview) revert WrongStatus(id, m.status);
        Panel storage p = _panels[id][m.round];
        if (p.size == 0 || block.number <= p.seedBlock) revert PanelNotReady();
        if (p.members.length != 0) revert PanelAlreadyDrawn();
        bytes32 h = _blockHash(p.seedBlock);
        if (h == 0) {
            p.seedBlock = uint64(block.number + PANEL_DELAY_BLOCKS);
            p.reschedules += 1;
            emit PanelScheduled(id, m.round, p.seedBlock);
            return;
        }
        bytes32 seed = keccak256(abi.encode(h, block.chainid, address(this), id, m.round, p.reschedules));
        uint256 n = getRoleMemberCount(VERIFIER_ROLE);
        if (n == 0) revert NoVerifiers();
        uint256 want = p.size;
        for (uint256 j = 0; p.members.length < want && j < want * 20 + 50; j++) {
            address a = getRoleMember(VERIFIER_ROLE, uint256(keccak256(abi.encode(seed, j))) % n);
            if (a == m.responsible || _onPanel(p, a)) continue;
            p.members.push(a);
        }
        // Never fewer than needed to decide: fill in order from a random start if the draw fell short.
        uint256 start = uint256(seed) % n;
        for (uint256 k = 0; p.members.length < want && k < n; k++) {
            address a = getRoleMember(VERIFIER_ROLE, (start + k) % n);
            if (a != m.responsible && !_onPanel(p, a)) p.members.push(a);
        }
        p.drawnAt = uint64(block.timestamp);
        emit PanelDrawn(id, m.round, p.members);
    }

    /// @notice A drawn panel that hasn't decided within PANEL_TIMEOUT is drawn again (anyone may
    ///         ask): a checker who never answers can't freeze a review. Checks already made count.
    function redrawPanel(uint256 id) external {
        Mandate storage m = _get(id);
        if (m.status != Status.UnderReview) revert WrongStatus(id, m.status);
        Panel storage p = _panels[id][m.round];
        if (p.members.length == 0 || block.timestamp < p.drawnAt + PANEL_TIMEOUT) revert PanelNotReady();
        delete p.members;
        p.seedBlock = uint64(block.number + PANEL_DELAY_BLOCKS);
        p.reschedules += 1;
        emit PanelScheduled(id, m.round, p.seedBlock);
    }

    /// @notice This round's panel: wanted size, seed block, and the checkers drawn (empty until drawn).
    function panelOf(uint256 id, uint32 round) external view returns (uint16 size, uint64 seedBlock, address[] memory members) {
        Panel storage p = _panels[id][round];
        return (p.size, p.seedBlock, p.members);
    }

    /// @notice When this round's panel was drawn, and how many times its draw was set again (public).
    function panelHistory(uint256 id, uint32 round) external view returns (uint64 drawnAt, uint16 reschedules) {
        Panel storage p = _panels[id][round];
        return (p.drawnAt, p.reschedules);
    }


    /// Block hashes older than 256 blocks, from the chain's history contract (EIP-2935, about
    /// 8191 blocks: hours rather than minutes on Base), so nobody can wait out a draw to get a new one.
    address private constant BLOCK_HISTORY = 0x0000F90827F1C53a10cb7A02335B175320002935;

    function _blockHash(uint256 n) internal view returns (bytes32 h) {
        h = blockhash(n);
        if (h != 0 || n >= block.number || BLOCK_HISTORY.code.length == 0) return h;
        (bool ok, bytes memory out) = BLOCK_HISTORY.staticcall(abi.encode(n));
        if (ok && out.length == 32) h = abi.decode(out, (bytes32));
    }

    function _onPanel(Panel storage p, address a) private view returns (bool) {
        for (uint256 i = 0; i < p.members.length; i++) if (p.members[i] == a) return true;
        return false;
    }

    // --------------------------------------------------------------- verifiers

    /**
     * @notice Approve or reject the evidence under review. One attestation per
     *         verifier per round; the first side to reach `threshold` decides.
     * @param reasonCID  IPFS CID of the verifier's written reasoning (may be empty).
     */
    function attest(uint256 id, bool approve, string calldata reasonCID) external onlyRole(VERIFIER_ROLE) {
        Mandate storage m = _get(id);
        if (m.status != Status.UnderReview) revert WrongStatus(id, m.status);
        if (msg.sender == m.responsible) revert ResponsibleCannotVerify();
        if (hasAttested[id][m.round][msg.sender]) revert AlreadyAttested();
        Panel storage p = _panels[id][m.round];
        if (p.size != 0) {
            if (p.members.length == 0) revert PanelNotReady();
            if (!_onPanel(p, msg.sender)) revert NotOnPanel();
        }
        if (bytes(reasonCID).length > MAX_CID_LENGTH) revert InvalidCID();

        hasAttested[id][m.round][msg.sender] = true;
        emit Attested(id, m.round, msg.sender, approve, reasonCID);

        if (approve) {
            if (++m.approvals >= m.threshold) {
                m.status = Status.Fulfilled;
                m.settledAt = uint64(block.timestamp);
                emit MandateFulfilled(id, m.round, m.evidenceCID);
            }
        } else if (++m.rejections >= m.threshold) {
            m.status = Status.Active;
            emit EvidenceRejected(id, m.round);
            delete m.evidenceCID;
        }
    }

    // ------------------------------------------------------------------- views

    function getMandate(uint256 id) external view returns (Mandate memory) {
        return _mandates[_exists(id)];
    }

    function statusOf(uint256 id) public view returns (Status) {
        return _mandates[id].status;
    }

    function responsibleOf(uint256 id) external view returns (address) {
        return _mandates[id].responsible;
    }

    function isFulfilled(uint256 id) external view returns (bool) {
        return _mandates[id].status == Status.Fulfilled;
    }

    function isCancelled(uint256 id) external view returns (bool) {
        return _mandates[id].status == Status.Cancelled;
    }

    /// @notice Past deadline and still open (Active or UnderReview).
    function isOverdue(uint256 id) external view returns (bool) {
        Mandate storage m = _mandates[id];
        return (m.status == Status.Active || m.status == Status.UnderReview) && block.timestamp > m.deadline;
    }

    // ---------------------------------------------------------------- internal

    function _get(uint256 id) private view returns (Mandate storage) {
        return _mandates[_exists(id)];
    }

    function _exists(uint256 id) private view returns (uint256) {
        if (_mandates[id].status == Status.None) revert UnknownMandate(id);
        return id;
    }

    function _checkCID(string calldata cid) private pure {
        uint256 len = bytes(cid).length;
        if (len == 0 || len > MAX_CID_LENGTH) revert InvalidCID();
    }
}
