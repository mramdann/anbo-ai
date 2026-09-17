use super::Activity;
use std::collections::HashMap;

#[derive(Default)]
pub(super) struct Members {
    states: HashMap<u64, Activity>,
}

impl Members {
    pub fn get(&self, id: u64) -> Option<&Activity> {
        self.states.get(&id)
    }

    pub fn values(&self) -> impl Iterator<Item = &Activity> {
        self.states.values()
    }

    pub fn record(&mut self, event: &Activity) -> (bool, Option<Activity>) {
        if let Some(previous) = self.get(event.control_id) {
            if !super::accepts(previous, event) {
                return (false, None);
            }
            if previous.request_id == event.request_id && previous.phase == event.phase {
                return (false, None);
            }
        }
        let mut evicted = None;
        if !self.states.contains_key(&event.control_id) && self.states.len() >= super::MAX_CONTROLS
        {
            if let Some(id) = self
                .states
                .values()
                .min_by_key(|state| (state.phase != "ended", state.sequence))
                .map(|state| state.control_id)
            {
                evicted = self
                    .states
                    .remove(&id)
                    .filter(|state| state.phase != "ended");
            }
        }
        let mut state = event.clone();
        state.point = None;
        self.states.insert(event.control_id, state);
        (true, evicted)
    }

    pub fn finish(&mut self, id: u64, caller: &super::Caller, sequence: u64) -> Option<Activity> {
        let event = self.states.get_mut(&id)?;
        if event.phase == "ended" || &event.actor != caller {
            return None;
        }
        event.phase = "ended";
        event.sequence = sequence;
        Some(event.clone())
    }
}
