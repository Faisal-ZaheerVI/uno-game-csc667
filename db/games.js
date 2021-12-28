const db = require('../db');
var format = require('pg-format'); // To SQL insert nested array of array values with one query

// Constants
const MAX_PLAYERS = 4;

// SQL statement presets:
const CREATE_GAME = 'INSERT INTO games (direction, user_id, title, created) VALUES (1, $1, $2, $3) RETURNING id;';
const INSERT_CARD_QUERY = 'INSERT INTO game_cards (card_id, game_id, user_id, "order", discarded, draw_pile) VALUES (${card_id}, ${game_id}, ${user_id}, ${order}, 0, 1);';
const INSERT_SHUFFLED_CARDS = 'INSERT INTO game_cards (card_id, game_id, user_id, "order", discarded, active_discard, draw_pile) VALUES %L;';
const INSERT_USER_INTO_GAME = 'INSERT INTO game_players (game_id, user_id, current_player, "order") VALUES (${game_id}, ${user_id}, ${current_player}, ${order}) RETURNING game_id AS id;';
const UPDATE_CARDS_NEW_PLAYER = 'UPDATE game_cards SET user_id=${user_id}, draw_pile=0 WHERE game_id=${game_id} AND "order"=${order} RETURNING game_id AS id;';

const LIST_OF_GAMES = 'SELECT * FROM games;';
const ALL_PLAYERS_IN_GAME = 'SELECT * FROM game_players WHERE game_id=${game_id};';
const NUM_PLAYERS_IN_GAME = 'SELECT COUNT(*) FROM game_players WHERE game_id=${game_id};';
const SELECT_ALL_CARDS_IN_GAME = 'SELECT * from game_cards WHERE game_id=${game_id};';
const SELECT_USER_FROM_GAME = 'SELECT * FROM game_players WHERE game_id=$1 AND user_id=$2;';

const GET_DISCARD_CARDS = 'SELECT * FROM game_cards WHERE game_id=$1 AND discarded=1 AND active_discard=0;';
const GET_ACTIVE_DISCARD = 'SELECT * FROM game_cards WHERE game_id=$1 AND active_discard=1;';
const REMOVE_ACTIVE_DISCARDS = 'UPDATE game_cards SET active_discard=0 WHERE game_id=$1 AND active_discard=1;';
const PLAY_CARD = 'UPDATE game_cards SET discarded=1, active_discard=1 WHERE card_id=$1 AND game_id=$2 RETURNING game_id AS id;';
const REMOVE_CURRENT_PLAYER = 'UPDATE game_players SET current_player=0 WHERE game_id=${game_id} AND "order"=${order} RETURNING game_id AS id;';
const UPDATE_CURRENT_PLAYER = 'UPDATE game_players SET current_player=1 WHERE game_id=${game_id} AND "order"=${order} RETURNING game_id AS id;';

const GET_DRAW_PILE_CARDS = 'SELECT * FROM game_cards WHERE game_id=$1 AND draw_pile=1 AND discarded=0 AND active_discard=0;';
const INSERT_DRAW_CARD = 'UPDATE game_cards SET user_id=$1, discarded=0, active_discard=0, draw_pile=0 WHERE game_id=$2 AND card_id=$3;';
const INSERT_TWO_DRAW_CARDS = 'UPDATE game_cards SET user_id=$1, discarded=0, active_discard=0, draw_pile=0 WHERE game_id=$2 AND card_id=$3 AND card_id=$4;';
const GET_USER_BY_ORDER = 'SELECT * FROM game_players WHERE game_id=$1 AND "order"=$2;';
// Uses card_id<109 so that colored Wild cards are not put in draw_pile (they are for visuals only).
const DISCARD_TO_DRAW_PILE = 'UPDATE game_cards SET draw_pile=1, discarded=0, active_discard=0 WHERE game_id=$1 AND discarded=1 AND active_discard=0 AND card_id<109;';

const PLAY_WILD_CARD = 'UPDATE game_cards SET discarded=1 WHERE card_id=$1 AND game_id=$2 RETURNING game_id AS id;';
const UPDATE_ACTIVE_WILD_CARD = 'UPDATE game_cards SET active_discard=1 WHERE card_id=$1 AND game_id=$2 RETURNING game_id AS id;';

const randomNumber = (min, max) => {
    min = Math.ceil(min);
    max = Math.floor(max);
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

const nextPlayerOrder = (currentUserOrder, direction) => {
    let nextPlayerOrder = currentUserOrder;

    // Order is NOT reversed.
    if(direction == 1) {
        if(currentUserOrder == 4) {
            nextPlayerOrder = 1;
        } else {
            nextPlayerOrder++;
        }
    }
    // Order IS reversed. (when reversed card is played)
    else if(direction == -1) {
        if(currentUserOrder == 1) {
            nextPlayerOrder = 4;
        } else {
            nextPlayerOrder--;
        }
    }
    return nextPlayerOrder;
}

const skipNextPlayerOrder = (currentUserOrder) => {
    let nextPlayerOrder = currentUserOrder;

    // Regardless of direction, a skip always goes to other end of the board.
    // (i.e.) If player 1 skips P2 turn, it will go to P3 turn regardless of direction.
    switch(currentUserOrder) {
        case 1: nextPlayerOrder = 3; break;
        case 2: nextPlayerOrder = 4; break;
        case 3: nextPlayerOrder = 1; break;
        case 4: nextPlayerOrder = 2; break;
        default: break;
    }

    return nextPlayerOrder;
}

// Sets up a valid default game state when a game is created.
// Could add number of users we want per game (i.e. 4 players)
const create = (user_id, title) => 
    // Inserts new game into game table
    db.one(CREATE_GAME, [user_id, title, "now()"])
    .then(({ id }) => 
        // Inserts user who created the new game into game_players table
        db.one(INSERT_USER_INTO_GAME, {game_id: id, user_id, current_player: 1, order: 1})
    )
    .then(({ id }) =>
        // Get cards from the lookup table
        // Promise.all() takes multiple promises and waits for all to be resolved before
        // going to next step, provides all promises' results as inputs.
        Promise.all([{ id }, db.any('SELECT * FROM cards;')])
    )
    .then(([ {id}, cards ]) => {
        // Shuffle cards here:
        let rawCards = cards;
        let shuffledCards = shuffle(rawCards, id, user_id);
        var sql = format(INSERT_SHUFFLED_CARDS, shuffledCards);
        return Promise.all([{id}, db.any(sql)]);
    })
    // Return the game_id as id (for front end to redirect as /games/id)
    .then(([{ id }]) => ({ id }));

const join = (user_id, game_id) => 
    userCount(game_id)
    .then(({ count }) => {
            // Check if user has already joined
            return db.any(ALL_PLAYERS_IN_GAME, {game_id})
                    .then((results) => {
                            console.log("Joining game...");
                            let playerExists = false;
                            for(var i = 0; i < results.length; i++) {
                                if(results[i].user_id == user_id) {
                                    playerExists = true;
                                }
                            }
                            if(!playerExists) {
                                // If Game isn't full (less than MAX_PLAYERS (4) players), insert player trying to join into the game.
                                if({count}.count < MAX_PLAYERS) {
                                    // New player is inserted into the game.
                                    return newPlayer(user_id, game_id, count);
                                }
                                else {
                                    // Game is full, user can't join this game.
                                    console.log("Game is currently full. Join canceled.");
                                    return {id: -1};
                                }
                            } else {
                                // User has already joined the game.
                                console.log("Already joined the game.");
                                return {id: results[0].game_id};
                            }
                    })
    });

const userCount = (game_id) => 
        db.one(NUM_PLAYERS_IN_GAME, 
        { game_id }
        );

const listGames = () => {
    return db.any(LIST_OF_GAMES);
}

const userListByGame = (game_id) => 
        db.any(ALL_PLAYERS_IN_GAME, 
        { game_id }
        );

const shuffle = (cards, game_id, user_id) => {
    let j, x, i;
    let cardsArray = []; // Nested arrays of values to insert in one format SQL query
    // FIELDS: card_id, game_id, user_id, "order", discarded, active_discard, draw_pile
    // Cards.length = 116 with visual wild cards (108 base game cards)
    // Cards.length - 9 because we aren't adding the 8 visual wild cards to deck (only for display purposes)
    for(i = cards.length - 9; i >= 0; i--) {
        j = Math.floor(Math.random() * (i + 1));
        x = cards[i];
        cards[i] = cards[j];
        cards[j] = x;
        if (i < 7) {
            // Set last 7 shuffled cards to Player 1's hand
            cardsArray.push([cards[i].id, game_id, user_id, i+1, 0, 0, 0]);
        } 
        else if(i == 7) {
            // Init one card for discard pile on game start.
            cardsArray.push([cards[i].id, game_id, user_id, i+1, 1, 1, 0]);
        }
        else {
            // Set to Draw Pile (sets default to user_id bc can't currently set user_id = 0 aka violates foreign key)
            cardsArray.push([cards[i].id, game_id, user_id, i+1, 0, 0, 1]);
        }
    }

    // Insert colored Wild cards into discard pile (not to be used except visual purposes)
    for(i = cards.length - 1; i >= cards.length - 8; i--) {
        cardsArray.push([cards[i].id, game_id, user_id, i+1, 1, 0, 0]);
    }

    return cardsArray;
}

const newPlayer = (user_id, game_id, count) =>
    db.one(INSERT_USER_INTO_GAME, {game_id, user_id, current_player: 0, order: parseInt(count) + 1})
        .then(({ id }) => {
            return Promise.all([{id}, db.any(SELECT_ALL_CARDS_IN_GAME, {game_id: id})]);
        })
        .then(([{ id }, game_cards]) => {
            let cards = game_cards;
            let newCards = [];
            let count = 0;
            // cards.length - 8 to avoid colored Wild cards in new player's deck.
            for (var i = 0; i < cards.length - 8; i++) {
                if(cards[i].draw_pile == 1 && cards[i].discarded == 0 && count < 7) {
                    cards[i].user_id = user_id;
                    newCards.push({
                        user_id: cards[i].user_id, 
                        game_id: id, 
                        card_id: cards[i].card_id, 
                        order: cards[i].order, 
                        draw_pile: 0
                    });
                    count++;
                }
            }
            return Promise.all([
                { id }, 
                ... newCards.map((card) => db.any(UPDATE_CARDS_NEW_PLAYER, {user_id, game_id: id, order: card.order}))
            ]);
        })
        .then(([{ id }]) => ({ id }));

const getGameState = (gameId) => {
    const players = 'SELECT * FROM game_players WHERE game_id=$1;';
    const cards = 'SELECT * FROM game_cards WHERE game_id=$1;';
    const direction = 'SELECT direction FROM games WHERE id=$1;';
    return Promise.all([db.any(players, gameId), db.any(cards, gameId), db.one(direction, gameId)]);
}

const getCardFromGame = (gameId, cardId) => {
    // console.log("Checking if user_id", userId, "holds card_id", cardId);
    return db.one('SELECT * FROM game_cards WHERE game_id=$1 AND card_id=$2;', [gameId, cardId]);
}

const getUserFromGame = (gameId, userId) => {
    return db.one(SELECT_USER_FROM_GAME, [gameId, userId]);
}

const getGameDiscardCards = (gameId) => {
    return db.any(GET_DISCARD_CARDS, [gameId]);
}

const getActiveDiscard = (gameId) => {
    return db.one(GET_ACTIVE_DISCARD, [gameId]);
}

// TODO: Add direction parameter (and others to accomodate for special cards)
const playValidCard = (cardId, gameId, userOrder) => {
    // Hard coded for normal direction (direction = 1).
    // Change to -1 or take direction as parameter
    // Change for Skip, +2, +4 cards?
    const nextOrder = nextPlayerOrder(userOrder, 1);

    return Promise.all([
        // Removes cards on top of discard (visibility purposes)
        db.any(REMOVE_ACTIVE_DISCARDS, [gameId]),
        // Adds played card as top of the discard pile (visible upon gameState update)
        db.one(PLAY_CARD, [cardId, gameId]),
        // Removes current player status from current user.
        db.one(REMOVE_CURRENT_PLAYER, {game_id: gameId, order: userOrder}),
        // Adds current player status to the next player 
        // (determined by order, TODO add: direction/special cards effect)
        db.one(UPDATE_CURRENT_PLAYER, {game_id: gameId, order: nextOrder})
    ]);
}

// TODO: Add direction parameter (and others to accomodate for special cards)
const drawCard = (gameId, userId, userOrder) => {
    return db.any(GET_DRAW_PILE_CARDS, [gameId])
    .then((drawCards) => {
        // If Draw cards are EMPTY (no more cards in draw pile), reshuffle discard pile:
        /**
         * 1) Get all discarded=1 cards (active_discard=0)
         * 2) Set cards to draw_pile=1, discarded=0, active_discard=0
         */
        if(drawCards.length < 1) {
            db.any(DISCARD_TO_DRAW_PILE, [gameId])
            .catch(console.log);
        }

        // Array of objects (cards in draw_pile)
        // user_id, game_id, card_id, order, discarded, active_discard, draw_pile
        const randomCardIndex = randomNumber(0, drawCards.length - 1);
        const drawCardId = drawCards[randomCardIndex].card_id;
        const nextOrder = nextPlayerOrder(userOrder, 1);
        console.log("Draw card id=", drawCardId);
        return Promise.all([
            // Inserts draw card to the user deck in the game.
            db.one(INSERT_DRAW_CARD, [userId, gameId, drawCardId]),
            // Removes current player status from current user.
            db.one(REMOVE_CURRENT_PLAYER, {game_id: gameId, order: userOrder}),
            // Adds current player status to the next player 
            // (determined by order, TODO add: direction/special cards effect)
            db.one(UPDATE_CURRENT_PLAYER, {game_id: gameId, order: nextOrder})
        ]);
    })
    .catch(console.log);
}

// TODO: Skip next player's turn and give skipped player 2 drawn cards.
// TODO: Factor in direction as to who gets skipped and given 2 cards.
// Currently skips player but doesn't give two cards.
const playPlusTwoCard = (cardId, gameId, userOrder) => {
    // Removes cards on top of discard (visibility purposes)
    // Adds played card as top of the discard pile (visible upon gameState update)
    // TODO: Add two cards to SKIPPED player deck.
    // Removes current player status from current user.
    // Adds current player status to the next player 

    // Change 1 to some direction (for reverse cases)
    let skippedOrder = nextPlayerOrder(userOrder, 1);
    let nextOrder = skipNextPlayerOrder(userOrder);
    
    return Promise.all([
        // Removes cards on top of discard (visibility purposes)
        db.any(REMOVE_ACTIVE_DISCARDS, [gameId]),
        // Adds played card as top of the discard pile (visible upon gameState update)
        db.one(PLAY_CARD, [cardId, gameId]),

        // Adds two cards to SKIPPED player's deck.
        db.one(GET_USER_BY_ORDER, [gameId, skippedOrder])
        .then((users) => {
            console.log("User by order:", users.user_id);
            return db.any(GET_DRAW_PILE_CARDS, [gameId])
            .then((drawCards) => {
                // If draw pile empty, reshuffled discards and refill draw pile.
                if(drawCards.length < 1) {
                    db.any(DISCARD_TO_DRAW_PILE, [gameId])
                    .catch(console.log);
                }
                const randomCardIndex1 = randomNumber(0, drawCards.length - 1);
                const drawCardId1 = drawCards[randomCardIndex1].card_id;
                let randomCardIndex2 = randomNumber(0, drawCards.length - 1);
                // Make sure user is not given the same card twice.
                while(randomCardIndex2 == randomCardIndex1) {
                    randomCardIndex2 = randomNumber(0, drawCards.length - 1);
                }
                const drawCardId2 = drawCards[randomCardIndex2].card_id;
                return Promise.all([
                    //users[0].user_id --> Skipped player's user id
                    db.one(INSERT_DRAW_CARD, [users.user_id, gameId, drawCardId1]),
                    db.one(INSERT_DRAW_CARD, [users.user_id, gameId, drawCardId2])
                ]);
                // return db.one(INSERT_TWO_DRAW_CARDS, [users.user_id, gameId, drawCardId1, drawCardId2]);
                // db.one(INSERT_DRAW_CARD, [users[0].user_id, gameId, drawCardId2])
            })
            .catch(console.log);
        })
        .catch(console.log),

        // Removes current player status from current user.
        db.one(REMOVE_CURRENT_PLAYER, {game_id: gameId, order: userOrder}),
        // Adds current player status to the next player 
        // (determined by order, TODO add: direction/special cards effect)
        db.one(UPDATE_CURRENT_PLAYER, {game_id: gameId, order: nextOrder})
    ]);
}

// TODO: Reverse the board (forwards = 1 or backwards = -1).
// Currently hard coded as normal colored valid card.
const playReverseCard = (cardId, gameId, userOrder) => {
    const nextOrder = nextPlayerOrder(userOrder, 1);

    return Promise.all([
        // Removes cards on top of discard (visibility purposes)
        db.any(REMOVE_ACTIVE_DISCARDS, [gameId]),
        // Adds played card as top of the discard pile (visible upon gameState update)
        db.one(PLAY_CARD, [cardId, gameId]),
        // Removes current player status from current user.
        db.one(REMOVE_CURRENT_PLAYER, {game_id: gameId, order: userOrder}),
        // Adds current player status to the next player 
        // (determined by order, TODO add: direction/special cards effect)
        db.one(UPDATE_CURRENT_PLAYER, {game_id: gameId, order: nextOrder})
    ]);
}

// TODO: Factor in direction parameter.
// COMPLETED: Skips the next player's turn.
// It is now the player after the skipped player's turn.
const playSkipCard = (cardId, gameId, userOrder) => {
    const nextOrder = skipNextPlayerOrder(userOrder);

    return Promise.all([
        // Removes cards on top of discard (visibility purposes)
        db.any(REMOVE_ACTIVE_DISCARDS, [gameId]),
        // Adds played card as top of the discard pile (visible upon gameState update)
        db.one(PLAY_CARD, [cardId, gameId]),
        // Removes current player status from current user.
        db.one(REMOVE_CURRENT_PLAYER, {game_id: gameId, order: userOrder}),
        // Adds current player status to the next player 
        // (determined by order, TODO add: direction/special cards effect)
        db.one(UPDATE_CURRENT_PLAYER, {game_id: gameId, order: nextOrder})
    ]);
}

// TODO: Based on color chosen, add colored Wild card to active_discard.
// TODO: Factor in direction parameter.
const playWildCard = (cardId, gameId, userOrder, color) => {
    const nextOrder = nextPlayerOrder(userOrder, 1);
    let wildCardId = 0;
    console.log("Color is", color, "of type", typeof(color));

    // IDs of colored Wild cards are 109,111,113,115 for Red,Blue,Green,Yellow respectively.
    switch(color) {
        case "red": wildCardId = 109; break;
        case "blue": wildCardId = 111; break;
        case "green": wildCardId = 113; break;
        case "yellow": wildCardId = 115; break;
        default: break;
    }

    if(wildCardId == 0) {
        console.log("ERROR: wildCardId is 0!");
    }

    return Promise.all([
        // Removes cards on top of discard (visibility purposes)
        db.any(REMOVE_ACTIVE_DISCARDS, [gameId]),
        // Adds played card to the discard pile.
        db.one(PLAY_WILD_CARD, [cardId, gameId]),
        // NEW: Adds chosen color Wild Card to active_discard pile (for visibility).
        db.one(UPDATE_ACTIVE_WILD_CARD, [wildCardId, gameId]),
        // Removes current player status from current user.
        db.one(REMOVE_CURRENT_PLAYER, {game_id: gameId, order: userOrder}),
        // Adds current player status to the next player 
        // (determined by order, TODO add: direction/special cards effect)
        db.one(UPDATE_CURRENT_PLAYER, {game_id: gameId, order: nextOrder})
    ]);
}

// TODO: Skip next player's turn, but give them 4 drawn cards.
// TODO: Based on color chosen, add colored Wild +4 to active_discard.
// TODO: Factor in direction to account for who gets skipped and drawn 4 cards.
const playWildPlusFourCard = (cardId, gameId, userOrder, color) => {
    let nextOrder = skipNextPlayerOrder(userOrder);
    
    return Promise.all([
        // Removes cards on top of discard (visibility purposes)
        db.any(REMOVE_ACTIVE_DISCARDS, [gameId]),
        // Adds played card as top of the discard pile (visible upon gameState update)
        db.one(PLAY_CARD, [cardId, gameId]),
        // Removes current player status from current user.
        db.one(REMOVE_CURRENT_PLAYER, {game_id: gameId, order: userOrder}),
        // Adds current player status to the next player 
        // (determined by order, TODO add: direction/special cards effect)
        db.one(UPDATE_CURRENT_PLAYER, {game_id: gameId, order: nextOrder})
    ]);
}

module.exports = {
    create, 
    join, 
    userCount,
    listGames,
    userListByGame,
    getGameState,
    getCardFromGame,
    getUserFromGame,
    getGameDiscardCards,
    getActiveDiscard,
    playValidCard,
    drawCard,
    playPlusTwoCard,
    playReverseCard,
    playSkipCard,
    playWildCard,
    playWildPlusFourCard
}
