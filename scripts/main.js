Hooks.on("ready", initSwadeTurnModifiers)

/**
 * set up the entire module on "ready" hook
 */
function initSwadeTurnModifiers(){
  // set up global settings
  registerConfigs()

  initCombatTurnChangeHook();
  if (getMAPCarryingMode() === 2)
    Hooks.on('swadePreRollSkill', onHookSwadePreRollSkill)
}

/**
* set up debounced hook at system start and config  reload
*/
function initCombatTurnChangeHook(){
  // set up debounced combatTurnChange hook
  const onDebouncedHookTurnChange = foundry.utils.debounce(
    (combat, prior, current) => {
    return onHookTurnChange(combat, prior, current)
  }, game.settings.get('swade-turn-modifiers', 'debounce-timer')) 

  Hooks.on('combatTurnChange',  onDebouncedHookTurnChange)
}

/**
* Adquires turn info for current combatant from its owner
* @category Hooks
* @param combat  current combat
* @param prior   combatInfo from previous turn
* @param current data from current turn
*/
async function onHookTurnChange(combat, prior, current) {
  const combatant = combat.combatants.get(combat.current.combatantId)
  
  clearActionsFlags  (combat)
  clearActionsEffects(combat)

  if (currentPlayerOwnsCombatant(game.user, combatant)) {
    drawDialog(combatant)
    .then((proceed) => {  
      postSelectedToChat(proceed, combatant)

      if (getMAPCarryingMode() === 1) {
        // clearing effects again to avoid effect duplication on multiple drawDialog 
        if (proceed.isForcedClose === false) {
          clearActionsEffects(combat)  
          addActiveEffect(proceed, combatant.actor)        
        }
      } else {
        combatant.actor.setFlag('swade', 'actionsAmount', proceed.strActionsAmount)      
        combatant.actor.setFlag('swade', 'isRunning',     proceed.isRunning)
      }
    })
  }
}

/**
* draws dialog promp on screen, so user may select amount of actions and running
* @param {Combatant} current combatant on combat that triggered the dialog
* @returns object {.strActionsAmount: number 1 2 or 3, isRunning/isForcedClose : bool true or false}
* @todo add HOLD button, localization
* I explicitly decided against using actor.ownership to decide owners,
* since players may allow others to collaboratively edit their own characters.
* GMs are considered to only own NPCs.
* @todo comentar caso default de close
*/
async function drawDialog(combatant) {
  const runningPenalty = getRunningPenalty(combatant.actor);
  let strOneActionPenaltyText = appendMAPModifier(1)
  
  if (strOneActionPenaltyText === '(0)'){
    strOneActionPenaltyText = ''
  }

  return await foundry.applications.api.DialogV2.prompt({
    window: { title: 'Choose amount of actions in your turn' },
    content: `
        <label><input type="radio"    name="strActionsAmount" value="1" checked> One action ${strOneActionPenaltyText}</label>
        <label><input type="radio"    name="strActionsAmount" value="2"        > Two actions ${appendMAPModifier(2)} </label>
        <label><input type="radio"    name="strActionsAmount" value="3"        > Three actions ${appendMAPModifier(3)} </label>
        <label><input type="checkbox" name="isRunning"                         > Running (${runningPenalty}) </label>
      `,
    ok: {
      label: 'Submit',
      callback: (event, button, dialog) => {
        return {
          strActionsAmount : button.form.elements.strActionsAmount.value, 
          isRunning        : button.form.elements.isRunning.checked,
          isForcedClose     : false,
        }      
      }  
    },
    close : (event, button, dialog) => {
      return {
        strActionsAmount : combatant.actor.getFlag('swade', 'actionsAmount') ?? '1', 
        isRunning        : combatant.actor.getFlag('swade', 'isRunning'),
        isForcedClose     : true,
      }      
    }
  })
} 

/**
* Auxiliar function to write MAP modifier from setting in drawDialog
* @param nActionAmount number of actions (1, 2, 3)
* @returns string, format (${number}), ex (-2), (-4)
*/
function appendMAPModifier(nActionAmount){
  // I don't trust JS typecasting
  return '(' + game.settings.get('swade-turn-modifiers', `MAP-${nActionAmount.toString()}-action-debuff`).toString() + ')'
}

/**
* custom rules of ownership 
* @param player    current active player (game.user)
* @param {Combatant} combatant The combatant object acting on current turn
* @returns boolean
* @todo  improved ownership for extras controlled by players
*/
function currentPlayerOwnsCombatant(player, combatant) {
  // I explicitly decided against using actor.ownership to decide owners,
  // since players may allow others to collaboratively edit his own character.
  // GMs are considered to only own NPCs.
  const isGMControllingNPC      = player.isActiveGM && combatant.isNPC
  const isPlayerControllingSelf = (player.character != null) && 
                                  (player.character.id === combatant.actorId)
    
  return isGMControllingNPC || isPlayerControllingSelf
}

/**
* Executes on swadePreRollSkill hook, sets up MAP modifiers for current combatant. hook origin: swade.js
* Returning `false` in a hook callback will cancel the roll entirely
* @category Hooks
* @param {SwadeActor} actor          The actor that rolls the skill
* @param {SwadeItem} skill           The Skill item that is being rolled
* @param {TraitRoll} roll            The built base roll, without any modifiers
* @param {RollModifier[]} modifiers  An array of modifiers which are to be added to the roll
* @param {IRollOptions} options      The options passed into the roll function
*/
function onHookSwadePreRollSkill(actor, skill, roll, modifiers, options){
  const strActionsAmount = actor.getFlag('swade', 'actionsAmount') ?? '1'
  
  modifiers.push({
    value: game.settings.get('swade-turn-modifiers', `MAP-${strActionsAmount}-action-debuff`),
    label: `${strActionsAmount} Actions Penalty`,
    ignore: false,
  })

  if (actor.getFlag('swade', 'isRunning') === true) {
    modifiers.push({
      value: getRunningPenalty(actor),
      label: `Running penalty`,
      ignore: false,
    })
  }
  return true
}

/**
* Sends a chat message with info about user selection. Message senders/visibility logic is all here 
* @param dlgInpug  input receveid from drawDialog { strActionsAmount: number, isRunning/isForcedClose: bool }      
* @param {Combatant} combatant The combatant object 
* @todo  localization and improved style
*/
function postSelectedToChat(dlgInpug, combatant) {
  const bCanSendMessage = 
    (dlgInpug.isForcedClose === false) &&                                      // no need to print message when closing
    ((getMessageEnabledOptions() === 1) && (game.user.isActiveGM === false) || // enabled players send message
     (getMessageEnabledOptions() === 2))                                       // enabled everyone send message  

  if (bCanSendMessage) {
    const arGMs = []
    if ((game.user.isActiveGM === true) && (game.settings.get('swade-turn-modifiers', 'gm-choices-secret') === true)) {
      game.users.forEach(user => {
        if (user.isGM === true) {
          arGMs.push(user.id)
        }
      })
    }

    ChatMessage.create({
      content: `User ${game.user.name} controlling combatant ${combatant.name} ` +
               `chooses ${dlgInpug.strActionsAmount} actions ` + 
               (dlgInpug.isRunning ? `and is running ` : ``),
      whisper: arGMs,
    })
  }
}

/**
* Removes all swade.actionsAmount flags from combatants
* @param {Combat} combat current combat that triggered this function
*/
function clearActionsFlags(combat) {
  if (game.user.isActiveGM) {
    combat.combatants.forEach(element => {
      element.actor.unsetFlag('swade', 'actionsAmount')
    });
  }
}

/**
* Removes all custom effects created by this module from ALL actors in combat
* @param {Combat} combat current combat that triggered this function
*/
function clearActionsEffects(combat) { 
  if (game.user.isActiveGM) {    
    combat.combatants.forEach(element => {
      element.actor.collections.effects.forEach(effect => {      
        const swadeTurnModFlags = effect.flags.swadeTurnMod
        if ((swadeTurnModFlags !== undefined) &&
            (swadeTurnModFlags.custom === true)) {
          effect.delete()      
        }
      })
    })   
  }
}

/**
* returns the running penalty of a combatant based on its edges
* @param   {Actor}  actor          actor obj of combantant
* @returns {Number} actionPenalty  signed action penalty 
*/
function getRunningPenalty(actor) {
  const steadyHandsEdge = actor.itemTypes.edge.filter((e) => {
    return e.system.swid == game.settings.get('swade-turn-modifiers', `steady-hands-swid`)
    })

  if (steadyHandsEdge.length === 0)  
    return -2
  else
    return -1
}

/**
* given user select MAP options, transforms them in effects and add them to actor
* @param {Object} mapOptions object {.strActionsAmount: number 1 2 or 3, isRunning/isForcedClose : bool true or false}
* @param {Actor} actor 
*/
function addActiveEffect(mapOptions, actor) {  
  const arEffects = []
  
  // creates effect for multiple actions
  if (mapOptions.strActionsAmount !== '1') {
    const nMAPPenalty = game.settings.get('swade-turn-modifiers', `MAP-${mapOptions.strActionsAmount}-action-debuff`)
    const effect = createEmptyCustomActiveEffect(`${mapOptions.strActionsAmount} actions penalty (${nMAPPenalty})`)
    effect.changes.push({
      key  : 'system.stats.globalMods.trait',
      mode : 2, // 2 = add modifier
      value: nMAPPenalty
    })
    arEffects.push(effect)
  }

  if (mapOptions.isRunning === true) {
    const nRunningPenalty = getRunningPenalty(actor)
    const effect = createEmptyCustomActiveEffect(`Running penalty (${nRunningPenalty})`)
    effect.changes.push({
      key  : 'system.stats.globalMods.trait',
      mode : 2, // 2 = add modifier
      value: nRunningPenalty
    })
    arEffects.push(effect)
  }

  if (arEffects.length !== 0)
    actor.createEmbeddedDocuments('ActiveEffect', arEffects)
}

/**
* returns an empty boilerplate effect for module use
* @param   {String}            strName           effect name
* @returns {ActiveEffectData}  activeEffectData  empty effect with custom flag for module identification
*/
function createEmptyCustomActiveEffect(strName){
  // property "duration" added solely to identify effect as temporary
  // custom expiration rules are implemented in code to avoid effect duplication
  // ActiveEffect removal managed in clearActionsEffects
  return {
    name: strName,
    changes: [],
    flags: {
      swadeTurnMod: {
        custom : true,
      },
    },
    duration: { 
      turns: 1
    },
 }
}

/**
* register all configs used by the module
* only works when called from "ready" hook
*/
async function registerConfigs(){
  game.settings.register('swade-turn-modifiers', 'modifier-carrying-mode', {
    name: 'Modifier carrying mode',
    hint: `Select how the module will store and carry modifiers between MAP selection and rolls. \n \n` +
          `Selecting "Effects" is recommended for compatibility with SWADE Tools module — ` +
          `An temporary Active Effect will be added to the actor for the duration of the turn. \n \n` + 
          `Selecting "Flags" will store modifiers in a manner transparent to users without the use of active effects — uncompatible with SWADE Tools simple rools.` ,
    scope: 'world',
    config: true,
    type: Number,
    choices: {
      1: "Effects",
      2: "Flags"
    },
    default: 1,
    requiresReload: true, // need to disable/enable hooks and reset debounce
  })
  
  game.settings.register('swade-turn-modifiers', 'messages-enable-for', {
    name: 'Post MAP choices to chat',
    hint: `Sends a chat message with options selected by user on turn-start MAP selector`,
    scope: 'world',
    config: true,
    type: Number,
    choices: {
      0: "None",
      1: "Players only",
      2: "Everyone"
    },
    default: 2,
    requiresReload: false, 
  })

  game.settings.register('swade-turn-modifiers', 'gm-choices-secret', {
    name: 'GM MAP chat message visible only to himself',
    hint: `Requires "Post MAP choices to chat" set to "Everyone"`,
    scope: 'world',
    config: true,
    type: Boolean,
    default: true,
    requiresReload: false, 
  })

  game.settings.register('swade-turn-modifiers', 'debounce-timer', {
    name: 'DEBUG: turn start promp delay (ms)',
    hint: `Debounce timer for actions-selection dialog (in milisseconds). ` + 
          `Recomended values are between 1000 and 3000 ms. ` +
          `Increase this value in case the dialog shows up when changing rounds`,
    scope: 'world',
    config: true,
    type: Number,
    default: 1750,
    requiresReload: true, // reloading clears the old debounced hook and adds the new one 
  })

  game.settings.register('swade-turn-modifiers', 'MAP-1-action-debuff', {
    name: 'Override MAP penalty: 1 action',
    hint: `RAW, 1 action incurs no penalty`,
    scope: 'world',
    config: true,
    type: Number,
    default: 0,
    requiresReload: false, 
  })

  game.settings.register('swade-turn-modifiers', 'MAP-2-action-debuff', {
    name: 'Override MAP penalty: 2 actions',
    hint: `RAW, 2 actions incurs a penalty of -2 in each action.`,
    scope: 'world',
    config: true,
    type: Number,
    default: -2,
    requiresReload: false, 
  })

  game.settings.register('swade-turn-modifiers', 'MAP-3-action-debuff', {
    name: 'Override MAP penalty: 3 actions',
    hint: `RAW, 3 actions incurs a penalty of -4 in each action.`,
    scope: 'world',
    config: true,
    type: Number,
    default: -4,
    requiresReload: false, 
  })

  game.settings.register('swade-turn-modifiers', 'steady-hands-swid', {
    name: 'Override steady hands SWID',
    hint: `swid by which the edge "steady hands" is referenced in a character sheet (default "steady-hands")`,
    scope: 'world',
    config: true,
    type: String,
    default: 'steady-hands',
    requiresReload: false, 
  })
}

/**
* returns a constant informing current modifier carrying mode
* @returns {Number} 1 (Effects) or 2 (Flags)
*/
function getMAPCarryingMode() {
  return Number(game.settings.get('swade-turn-modifiers', 'modifier-carrying-mode'))
}

/**
* returns a constant informing current modifier carrying mode
* @returns {Number} 1 (Effects) or 2 (Flags)
*/
function getMessageEnabledOptions() {
  return Number(game.settings.get('swade-turn-modifiers', `messages-enable-for`))
}